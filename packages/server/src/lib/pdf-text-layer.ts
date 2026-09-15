import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { env } from "../env.ts";
import { ExtractAbortedError } from "./marker.ts";
import { scriptPath } from "./paths.ts";

export type TextLayerWord = { text: string; bbox: [number, number, number, number] };
/** One page's words in PDF points of the displayed page, origin top-left; pages are 1-based. */
export type TextLayerPage = { page: number; words: TextLayerWord[] };

export type TextLayerWriter = (input: {
  pdfPath: string;
  outPdfPath: string;
  pages: TextLayerPage[];
  /** Where the word list is written for the script to read */
  workDir: string;
  signal?: AbortSignal;
}) => Promise<void>;

// Copies the PDF with an invisible, searchable string per word, the way Surya's copies are made,
// through scripts/pdf_text_layer.py in the Python environment.
export function makeTextLayerWriter({ python, script }: { python?: string; script?: string } = {}): TextLayerWriter {
  return async ({ pdfPath, outPdfPath, pages, workDir, signal }) => {
    if (signal?.aborted) throw new ExtractAbortedError();
    const wordsPath = path.join(workDir, "words.json");
    await writeFile(wordsPath, JSON.stringify(pages));
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        python ?? path.join(env.CONDA_ENV_PATH, "python"),
        [script ?? scriptPath("pdf_text_layer.py"), "--pdf", pdfPath, "--out", outPdfPath, "--words", wordsPath],
        { env: { ...process.env, HF_HUB_OFFLINE: "1", PATH: `${env.CONDA_ENV_PATH}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "pipe"] },
      );
      const handleAbort = () => proc.kill("SIGKILL");
      signal?.addEventListener("abort", handleAbort, { once: true });
      const tail: string[] = [];
      createInterface({ input: proc.stderr }).on("line", (line) => {
        if (!line.trim()) return;
        tail.push(line.trim());
        if (tail.length > 20) tail.shift();
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
        else if (code !== 0) finish(new Error(`Text layer writer exited with code ${code}${tail.length ? `: ${tail.at(-1)}` : ""}`));
        else finish(null);
      });
    });
  };
}

export const writeTextLayer: TextLayerWriter = makeTextLayerWriter();
