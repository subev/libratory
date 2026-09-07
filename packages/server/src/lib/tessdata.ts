import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, cp, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { z } from "zod";

import { env } from "../env.ts";
import { isoForPack } from "./tesseract-languages.ts";
import { TESSDATA_COMMIT, TESSDATA_LANGUAGES, TESSDATA_REPO, type TessdataLanguage } from "./tessdata-manifest.ts";

const execFileAsync = promisify(execFile);

// A `tesseract … pdf` run needs all of these in the one directory TESSDATA_PREFIX names.
const STAGED = ["configs", "tessconfigs", "pdf.ttf", "eng.traineddata", "osd.traineddata"];

export type PackDownload = { received: number; total: number; error: string | null };
export type OcrLanguageStatus = TessdataLanguage & { iso: string | null; installed: boolean; download: PackDownload | null };

const exists = (p: string) => access(p).then(() => true, () => false);

export function tessdataDir(): string {
  return env.TESSDATA_PREFIX ?? path.resolve(env.DATA_DIR, "tessdata");
}

export function tesseractEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TESSDATA_PREFIX: tessdataDir() };
}

export async function defaultTessdataDir(): Promise<string> {
  const { TESSDATA_PREFIX: _unset, ...bare } = process.env;
  const { stdout, stderr } = await execFileAsync("tesseract", ["--list-langs"], { timeout: 30_000, env: bare });
  const dir = (stdout + stderr).match(/languages in "([^"]+)"/)?.[1];
  if (!dir) throw new Error("tesseract did not say where its language data lives");
  return dir;
}

export async function stageTessdata(dir = tessdataDir(), source: () => Promise<string> = defaultTessdataDir): Promise<void> {
  await mkdir(dir, { recursive: true });
  const missing: string[] = [];
  for (const name of STAGED) if (!(await exists(path.join(dir, name)))) missing.push(name);
  if (missing.length === 0) return;
  const from = await source();
  if (path.resolve(from) === path.resolve(dir)) return;
  for (const name of missing) {
    const item = path.join(from, name);
    if (!(await exists(item))) throw new Error(`${item} is missing — reinstall tesseract`);
    await cp(item, path.join(dir, name), { recursive: true });
  }
}

let staged: Promise<void> | null = null;

export function ensureTessdata(): Promise<void> {
  staged ??= stageTessdata().catch((err: unknown) => {
    staged = null;
    throw err;
  });
  return staged;
}

export async function installedPacks(dir = tessdataDir()): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".traineddata")).map((f) => f.slice(0, -".traineddata".length)).sort();
}

const downloads = new Map<string, PackDownload>();

export const packCodeSchema = z.string().refine((c) => TESSDATA_LANGUAGES.some((l) => l.code === c), "Unknown language pack");

export function manifestEntry(code: string): TessdataLanguage {
  const entry = TESSDATA_LANGUAGES.find((l) => l.code === code);
  if (!entry) throw new Error(`No language pack called "${code}"`);
  return entry;
}

export async function listOcrLanguages(dir = tessdataDir()): Promise<OcrLanguageStatus[]> {
  const installed = new Set(await installedPacks(dir));
  return TESSDATA_LANGUAGES.map((l) => ({
    ...l,
    iso: isoForPack(l.code),
    installed: installed.has(l.code),
    download: downloads.get(l.code) ?? null,
  }));
}

function describeDownloadError(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT"].includes(code)) {
    return "Could not reach github.com — no network";
  }
  return err instanceof Error ? err.message : String(err);
}

// git's blob SHA-1 from the pinned tree listing is the checksum, so it is verified without a second source
export async function downloadPack(lang: TessdataLanguage, dir: string, progress?: PackDownload): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${lang.code}.traineddata`);
  const part = `${target}.part`;
  const res = await fetch(`https://raw.githubusercontent.com/${TESSDATA_REPO}/${TESSDATA_COMMIT}/${lang.code}.traineddata`);
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${lang.name}`);

  const hash = createHash("sha1");
  hash.update(`blob ${lang.bytes}\0`);
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (progress) progress.received = received;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), counter, createWriteStream(part));
    if (received !== lang.bytes) throw new Error(`${lang.name} arrived as ${received} bytes, expected ${lang.bytes}`);
    if (hash.digest("hex") !== lang.sha1) throw new Error(`${lang.name} did not match its checksum`);
    await rename(part, target);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

export function startPackDownload(code: string, dir = tessdataDir()): { started: boolean } {
  const lang = manifestEntry(code);
  const current = downloads.get(code);
  if (current && current.error === null) return { started: false };
  const entry: PackDownload = { received: 0, total: lang.bytes, error: null };
  downloads.set(code, entry);
  downloadPack(lang, dir, entry).then(
    () => downloads.delete(code),
    (err: unknown) => { entry.error = describeDownloadError(err); },
  );
  return { started: true };
}

export async function removePack(code: string, dir = tessdataDir()): Promise<{ removed: boolean }> {
  const lang = manifestEntry(code);
  if (lang.code === "eng") throw new Error("English ships with the app and cannot be removed");
  const target = path.join(dir, `${lang.code}.traineddata`);
  if (!(await exists(target))) return { removed: false };
  await unlink(target);
  return { removed: true };
}
