import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ExtractAbortedError } from "./marker.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";
import { packName, packsForScript, tesseractLanguage, type TesseractLanguage } from "./tesseract-languages.ts";
import { ensureTessdata, installedPacks, tesseractEnv } from "./tessdata.ts";

const execFileAsync = promisify(execFile);

export type OcrStats = {
  confidence: number | null;
  lowConfidenceFraction: number | null;
};

export type OcrRunner = (input: {
  pdfPath: string;
  outPdfPath: string;
  /** The book's ISO-639-1 code, or null when it was never set. */
  language: string | null;
  workDir: string;
  log: (msg: string) => Promise<void>;
  signal?: AbortSignal;
}) => Promise<OcrStats>;

export const LOW_CONFIDENCE = 60;
const RENDER_DPI = 300;
const RENDER_CHUNK_PAGES = 20;

export async function pdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath], { timeout: 30_000 });
  const pages = Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new Error(`pdfinfo could not count the pages of "${path.basename(pdfPath)}"`);
  return pages;
}

function run(command: string, args: string[], signal: AbortSignal | undefined, onStderrLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractAbortedError());
      return;
    }
    const proc = spawn(command, args, { env: tesseractEnv(), stdio: ["ignore", "ignore", "pipe"] });
    const handleAbort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", handleAbort, { once: true });

    const tail: string[] = [];
    const rl = createInterface({ input: proc.stderr });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      tail.push(trimmed);
      if (tail.length > 20) tail.shift();
      onStderrLine?.(trimmed);
    });

    const finish = (err: Error | null) => {
      rl.close();
      signal?.removeEventListener("abort", handleAbort);
      if (err) reject(err);
      else resolve();
    };

    proc.on("error", (err) => finish(err));
    proc.on("close", (code) => {
      if (signal?.aborted) finish(new ExtractAbortedError());
      else if (code !== 0) finish(new Error(`${command} exited with code ${code}${tail.length ? `: ${tail.at(-1)}` : ""}`));
      else finish(null);
    });
  });
}

// pdftoppm pads page numbers to the document's page count, not the range's, so names come off disk.
async function renderPages(pdfPath: string, workDir: string, pages: number, log: (msg: string) => Promise<void>, signal?: AbortSignal): Promise<string[]> {
  for (let first = 1; first <= pages; first += RENDER_CHUNK_PAGES) {
    const last = Math.min(first + RENDER_CHUNK_PAGES - 1, pages);
    await log(`Rendering pages ${first}–${last} of ${pages}`);
    await run("pdftoppm", [
      "-r", String(RENDER_DPI), "-png", "-gray",
      "-f", String(first), "-l", String(last),
      pdfPath, path.join(workDir, "pg"),
    ], signal);
  }

  const rendered = (await readdir(workDir)).filter((f) => f.startsWith("pg-") && f.endsWith(".png")).sort();
  if (rendered.length !== pages) throw new Error(`Rendered ${rendered.length} of ${pages} pages before OCR`);
  return rendered.map((f) => path.join(workDir, f));
}

function statsFromTsv(tsv: string): OcrStats {
  let total = 0;
  let sum = 0;
  let low = 0;
  for (const line of tsv.split("\n").slice(1)) {
    const columns = line.split("\t");
    if (columns[0] !== "5") continue;
    const conf = Number(columns[10]);
    if (!Number.isFinite(conf) || conf < 0) continue;
    total++;
    sum += conf;
    if (conf < LOW_CONFIDENCE) low++;
  }
  if (total === 0) return { confidence: null, lowConfidenceFraction: null };
  return { confidence: sum / total / 100, lowConfidenceFraction: low / total };
}

export async function detectScript(png: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tesseract", [png, "-", "--psm", "0"], { timeout: 60_000, env: tesseractEnv() });
    const script = stdout.match(/^Script:\s*(\S+)/m)?.[1] ?? null;
    const confidence = Number(stdout.match(/^Script confidence:\s*([\d.]+)/m)?.[1]);
    return script && confidence >= 1 ? script : null;
  } catch {
    return null;
  }
}

function requireInstalled(installed: string[], choice: TesseractLanguage): TesseractLanguage {
  if (!installed.includes(choice.pack)) {
    throw new Error(`Tesseract has no ${choice.name} language pack (${choice.pack}.traineddata) — download it under "OCR language packs" in Settings`);
  }
  return choice;
}

// Reading a Cyrillic scan as English quietly is the failure this guards against: with no language
// on the book, the page's own script picks the pack, and a script with no installed pack stops here.
async function chooseLanguage(language: string | null, pdfPath: string, pages: number, workDir: string, signal: AbortSignal | undefined, log: (msg: string) => Promise<void>): Promise<TesseractLanguage> {
  const installed = await installedPacks();
  if (language) return requireInstalled(installed, tesseractLanguage(language));
  const sampleDir = path.join(workDir, "osd");
  await mkdir(sampleDir, { recursive: true });
  const samplePage = Math.min(5, pages);
  await run("pdftoppm", ["-r", String(RENDER_DPI), "-png", "-gray", "-f", String(samplePage), "-l", String(samplePage), pdfPath, path.join(sampleDir, "pg")], signal);
  const sample = (await readdir(sampleDir)).find((f) => f.endsWith(".png"));
  const script = sample ? await detectScript(path.join(sampleDir, sample)) : null;
  await rm(sampleDir, { recursive: true, force: true }).catch(() => {});
  const candidates = packsForScript(script);
  if (!script || candidates.length === 0) return requireInstalled(installed, tesseractLanguage("en"));
  const pack = candidates.find((c) => installed.includes(c));
  if (!pack) {
    const names = candidates.slice(0, 3).map(packName).join(", ");
    throw new Error(`${script} script on the page, but no pack for it is installed — download ${names} or another under "OCR language packs" in Settings, or set the book's language`);
  }
  await log(`${script} script on the page — reading it as ${packName(pack)}; set the book's language to choose`);
  return { pack, name: packName(pack) };
}

export const runTesseractOcr: OcrRunner = async ({ pdfPath, outPdfPath, language, workDir, log, signal }) => {
  await ensureTessdata();
  if (language) requireInstalled(await installedPacks(), tesseractLanguage(language));

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    const pages = await pdfPageCount(pdfPath);
    const { pack, name } = await chooseLanguage(language, pdfPath, pages, workDir, signal, log);
    const images = await renderPages(pdfPath, workDir, pages, log, signal);

    const listPath = path.join(workDir, "pages.txt");
    await writeFile(listPath, images.join("\n") + "\n");

    const base = path.join(workDir, "out");
    await log(`Reading ${pages} page${pages === 1 ? "" : "s"} with Tesseract (${name})`);
    let lastLogged = 0;
    await run("tesseract", [listPath, base, "-l", pack, "pdf", "tsv"], signal, (line) => {
      // "Page 0 : /…/pg-01.png", zero-based, one per page as it starts
      const match = line.match(/^Page (\d+) :/);
      if (!match?.[1]) return;
      const page = Number(match[1]) + 1;
      if (page <= lastLogged) return;
      lastLogged = page;
      log(`OCR page ${page}/${pages}`).catch(() => {});
    });

    const stats = statsFromTsv(await readFile(`${base}.tsv`, "utf-8"));
    await rename(`${base}.pdf`, outPdfPath);

    if ((await pdfHasTextLayer(outPdfPath)) !== true) {
      await rm(outPdfPath, { force: true });
      throw new Error("Tesseract produced a PDF with no readable text layer");
    }
    return stats;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};
