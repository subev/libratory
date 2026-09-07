import { execFile } from "node:child_process";
import { access, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";

import { db } from "../db.ts";
import { bookFiles } from "../schema.ts";
import { detectScript as detectPageScript, LOW_CONFIDENCE, pdfPageCount, statsFromConfidences } from "./ocr-tesseract.ts";
import { OCR_GARBLED_FRACTION } from "./ocr-text-layer.ts";
import { bookTmpDir } from "./paths.ts";
import { ensureTessdata, installedPacks, tesseractEnv } from "./tessdata.ts";
import { packName } from "./tesseract-languages.ts";

const execFileAsync = promisify(execFile);
const exists = (p: string) => access(p).then(() => true, () => false);

export const TRY_DPI = 150;
// OSD guessed wrong at 150 dpi on a clean English page (Cyrillic, confidence 0.3); at 300 it is right, and confident
const OSD_DPI = 300;
const PT_PER_PX = 72 / TRY_DPI;
const EDGE_BAND = 0.2;
const EDGE_SHARE = 0.75;

export type TryWord = { text: string; conf: number; x0: number; y0: number; x1: number; y1: number; lastOnLine: boolean };
export type TryLine = { text: string; words: TryWord[] };
export type Callout =
  | { kind: "clean"; count: number }
  | { kind: "edge"; count: number; side: "left" | "right"; bandPct: number; allLastWords: boolean }
  | { kind: "scattered"; count: number };

export async function tryTarget(bookId: string, fileIndex: number, page: number) {
  const [file] = await db.select().from(bookFiles).where(and(eq(bookFiles.bookId, bookId), eq(bookFiles.index, fileIndex)));
  if (!file) throw new Error("File not found");
  const pageCount = await pdfPageCount(file.pdfPath);
  return { file, pageCount, page: Math.max(1, Math.min(page, pageCount)) };
}

export function pagePngPath(bookId: string, fileIndex: number, page: number, suffix = ""): string {
  return path.join(bookTmpDir(bookId), "ocr-try", `f${fileIndex}-p${page}${suffix}.png`);
}

async function renderPng(png: string, pdfPath: string, page: number, dpi: number): Promise<string> {
  const dir = path.dirname(png);
  await mkdir(dir, { recursive: true });
  if (await exists(png)) return png;
  // pdftoppm names its output after the document's page count, so a scratch dir of its own is what
  // makes the one file it wrote findable however many pages the session has already tried.
  const scratch = path.join(dir, `render-${path.basename(png, ".png")}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    await execFileAsync("pdftoppm", ["-r", String(dpi), "-png", "-f", String(page), "-l", String(page), pdfPath, path.join(scratch, "pg")], { timeout: 60_000 });
    const produced = (await readdir(scratch)).find((f) => f.endsWith(".png"));
    if (!produced) throw new Error(`pdftoppm rendered nothing for page ${page}`);
    await rename(path.join(scratch, produced), png);
    return png;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

// Points, so the client can overlay word boxes on the image whatever size it draws it at
export async function renderTryPage(bookId: string, fileIndex: number, pdfPath: string, page: number): Promise<{ png: string; width: number; height: number }> {
  const png = await renderPng(pagePngPath(bookId, fileIndex, page), pdfPath, page, TRY_DPI);
  const size = await pngSize(png);
  return { png, width: size.width * PT_PER_PX, height: size.height * PT_PER_PX };
}

export async function detectScript(bookId: string, fileIndex: number, pdfPath: string, page: number): Promise<string | null> {
  const png = await renderPng(pagePngPath(bookId, fileIndex, page, "-osd"), pdfPath, page, OSD_DPI);
  await ensureTessdata();
  return detectPageScript(png);
}

export function parseTsvLines(tsv: string): TryLine[] {
  const lines = new Map<string, TryLine>();
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c[0] !== "5" || c.length < 12) continue;
    const conf = Number(c[10]);
    const text = (c[11] ?? "").trim();
    if (!Number.isFinite(conf) || conf < 0 || !text) continue;
    const key = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`;
    const line = lines.get(key) ?? { text: "", words: [] };
    const left = Number(c[6]) * PT_PER_PX;
    const top = Number(c[7]) * PT_PER_PX;
    line.words.push({ text, conf, x0: left, y0: top, x1: left + Number(c[8]) * PT_PER_PX, y1: top + Number(c[9]) * PT_PER_PX, lastOnLine: false });
    lines.set(key, line);
  }
  for (const line of lines.values()) {
    const last = line.words.at(-1);
    if (last) last.lastOnLine = true;
    line.text = line.words.map((w) => w.text).join(" ");
  }
  return [...lines.values()];
}

export function classifyDoubt(words: TryWord[], pageWidth: number): Callout {
  const doubted = words.filter((w) => w.conf < LOW_CONFIDENCE);
  const count = doubted.length;
  if (words.length === 0 || count / words.length < OCR_GARBLED_FRACTION) return { kind: "clean", count };
  const centre = (w: TryWord) => (w.x0 + w.x1) / 2;
  const right = doubted.filter((w) => centre(w) >= pageWidth * (1 - EDGE_BAND));
  const left = doubted.filter((w) => centre(w) <= pageWidth * EDGE_BAND);
  const [side, band] = right.length >= left.length ? (["right", right] as const) : (["left", left] as const);
  if (band.length / count < EDGE_SHARE) return { kind: "scattered", count };
  const extent = side === "right"
    ? pageWidth - Math.min(...band.map((w) => w.x0))
    : Math.max(...band.map((w) => w.x1));
  return { kind: "edge", count, side, bandPct: Math.min(100, Math.ceil((extent / pageWidth) * 100)), allLastWords: doubted.every((w) => w.lastOnLine) };
}

export async function tesseractPage(png: string, pack: string, pageWidth: number) {
  await ensureTessdata();
  if (!(await installedPacks()).includes(pack)) {
    throw new Error(`Tesseract has no ${packName(pack)} language pack (${pack}.traineddata) — download it first`);
  }
  const base = png.replace(/\.png$/, `-${pack}`);
  const started = Date.now();
  await execFileAsync("tesseract", [png, base, "-l", pack, "tsv"], { timeout: 300_000, env: tesseractEnv() });
  const elapsedMs = Date.now() - started;
  const lines = parseTsvLines(await readFile(`${base}.tsv`, "utf-8"));
  const words = lines.flatMap((l) => l.words);
  const stats = statsFromConfidences(words.map((w) => w.conf));
  return { lines, ...stats, elapsedMs, callout: classifyDoubt(words, pageWidth) };
}
