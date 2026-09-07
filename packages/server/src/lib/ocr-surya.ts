import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { env } from "../env.ts";
import { ExtractAbortedError } from "./marker.ts";
import { bundleInstalled, readCapabilities } from "./model-bundles.ts";
import type { OcrRunner } from "./ocr-tesseract.ts";
import { scriptPath } from "./paths.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";

export const SURYA_BUNDLE = "extraction";

export type SuryaEvent =
  | { event: "start"; pages: number }
  | { event: "page"; page: number; width: number; height: number }
  | { event: "detected"; page: number; lines: number }
  | { event: "line"; page: number; index: number; total: number; text: string; bbox: [number, number, number, number] }
  | { event: "page-done"; page: number; elapsedMs: number }
  | { event: "done"; elapsedMs: number };

const EVENTS = new Set(["start", "page", "detected", "line", "page-done", "done"]);

export function parseSuryaEvent(line: string): SuryaEvent | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) return null;
    return EVENTS.has(String(parsed.event)) ? (parsed as SuryaEvent) : null;
  } catch {
    return null;
  }
}

async function device(): Promise<"mps" | "cuda" | "cpu"> {
  if (process.platform === "darwin") return "mps";
  const capabilities = await readCapabilities().catch(() => null);
  return capabilities?.cuda ? "cuda" : "cpu";
}

export type SuryaSpawn = { python?: string; script?: string };

export type SuryaRun = {
  signal?: AbortSignal;
  onEvent?: (e: SuryaEvent) => void;
  onStderr?: (line: string) => void;
} & SuryaSpawn;

export function runSurya(args: string[], { signal, onEvent, onStderr, python, script }: SuryaRun, torchDevice: "mps" | "cuda" | "cpu"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExtractAbortedError());
      return;
    }
    const proc = spawn(python ?? path.join(env.CONDA_ENV_PATH, "python"), [script ?? scriptPath("ocr_surya.py"), ...args], {
      env: {
        ...process.env,
        TORCH_DEVICE: torchDevice,
        HF_HUB_OFFLINE: "1",
        OMP_NUM_THREADS: String(os.availableParallelism()),
        PATH: `${env.CONDA_ENV_PATH}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handleAbort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", handleAbort, { once: true });

    const tail: string[] = [];
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const event = parseSuryaEvent(line);
      if (event) onEvent?.(event);
    });
    createInterface({ input: proc.stderr }).on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      tail.push(trimmed);
      if (tail.length > 20) tail.shift();
      onStderr?.(trimmed);
    });

    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      if (err) reject(err);
      else resolve();
    };
    proc.on("error", (err) => finish(err));
    proc.on("close", (code) => {
      if (signal?.aborted) finish(new ExtractAbortedError());
      else if (code !== 0) finish(new Error(`Surya exited with code ${code}${tail.length ? `: ${tail.at(-1)}` : ""}`));
      else finish(null);
    });
  });
}

export const makeSuryaRunner = (spawnWith: SuryaSpawn = {}): OcrRunner => async ({ pdfPath, outPdfPath, workDir, log, signal }) => {
  if (!(await bundleInstalled(SURYA_BUNDLE))) {
    throw new Error("Surya needs the Marker/Surya models — download them from the Extract button first");
  }
  await mkdir(workDir, { recursive: true });
  let pages = 0;
  const onEvent = (e: SuryaEvent) => {
    if (e.event === "start") pages = e.pages;
    else if (e.event === "page") log(`OCR page ${e.page}/${pages}`).catch(() => {});
  };
  const args = ["--pdf", pdfPath, "--out", outPdfPath];
  const first = await device();
  try {
    try {
      await runSurya(args, { signal, onEvent, ...spawnWith }, first);
    } catch (err) {
      if (err instanceof ExtractAbortedError || first === "cpu") throw err;
      await log(`${first.toUpperCase()} OCR failed: ${err instanceof Error ? err.message : String(err)}. Retrying with CPU...`);
      await runSurya(args, { signal, onEvent, ...spawnWith }, "cpu");
    }
    if ((await pdfHasTextLayer(outPdfPath)) !== true) {
      await rm(outPdfPath, { force: true });
      throw new Error("Surya produced a PDF with no readable text layer");
    }
    return { confidence: null, lowConfidenceFraction: null };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

export const runSuryaOcr = makeSuryaRunner();
