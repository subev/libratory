import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { env } from "../env.ts";
import { ExtractAbortedError } from "./marker.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";
import { tesseractLanguage } from "./tesseract-languages.ts";

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

// A word this far down is one the confidence advisory counts as garbled.
const LOW_CONFIDENCE = 60;
const RENDER_DPI = 300;
const RENDER_CHUNK_PAGES = 20;

function tesseractEnv(): NodeJS.ProcessEnv {
  return env.TESSDATA_PREFIX ? { ...process.env, TESSDATA_PREFIX: env.TESSDATA_PREFIX } : process.env;
}

async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath], { timeout: 30_000 });
  const pages = Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1) throw new Error(`pdfinfo could not count the pages of "${path.basename(pdfPath)}"`);
  return pages;
}

async function installedPacks(): Promise<string[]> {
  const { stdout } = await execFileAsync("tesseract", ["--list-langs"], { timeout: 30_000, env: tesseractEnv() });
  return stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
}

function run(command: string, args: string[], signal: AbortSignal | undefined, onStderrLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractAbortedError());
      return;
    }
    const proc = spawn(command, args, { env: tesseractEnv() });
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

// pdftoppm pads the page number to the width of the document's own page count, not of the range
// asked for, so the names are read back off disk rather than predicted.
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

export const runTesseractOcr: OcrRunner = async ({ pdfPath, outPdfPath, language, workDir, log, signal }) => {
  const { pack, name } = tesseractLanguage(language);
  if (!(await installedPacks()).includes(pack)) {
    throw new Error(`Tesseract has no ${name} language pack (${pack}.traineddata) — install it into the tessdata directory`);
  }

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    const pages = await pageCount(pdfPath);
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
      void log(`OCR page ${page}/${pages}`);
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
