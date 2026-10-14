import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../env.ts";
import { scriptPath } from "./paths.ts";

const CONDA_BIN = env.CONDA_ENV_PATH;

const SYNTHESIZE_SCRIPT = scriptPath("synthesize.py");

type LogFn = (message: string) => Promise<void>;
type ProgressFn = (chunk: number, totalChunks: number) => Promise<void>;

const noopLog: LogFn = async () => {};
const noopProgress: ProgressFn = async () => {};

type SynthesizeOptions = {
  inputText: string;
  outputPath: string;
  voice: string;
  speed: number;
  chunkPreviewDir?: string | null;
  chunkPreviewUrlBase?: string | null;
  log?: LogFn;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
};

export class KokoroAbortedError extends Error {
  constructor() {
    super("Kokoro synthesis aborted");
    this.name = "KokoroAbortedError";
  }
}

export async function synthesize({ inputText, outputPath, voice, speed, chunkPreviewDir = null, chunkPreviewUrlBase = null, log = noopLog, onProgress = noopProgress, signal }: SynthesizeOptions): Promise<void> {
  const textPath = outputPath.replace(/\.wav$/, ".txt");
  await writeFile(textPath, inputText, "utf-8");

  const pythonBin = path.join(CONDA_BIN, "python");
  const wordCount = inputText.split(/\s+/).filter(Boolean).length;
  await log(`Starting Kokoro synthesis (${wordCount.toLocaleString()} words, voice: ${voice}, speed: ${speed}x)`);
  if (chunkPreviewUrlBase) {
    await log(`Chunk previews: ${chunkPreviewUrlBase}/chunk-001.wav`);
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new KokoroAbortedError());
      return;
    }

    const proc = spawn(
      pythonBin,
      [
        SYNTHESIZE_SCRIPT,
        "--input", textPath,
        "--output", outputPath,
        "--voice", voice,
        "--speed", String(speed),
        ...(chunkPreviewDir ? ["--chunks-dir", chunkPreviewDir] : []),
      ],
      {
        env: {
          ...process.env,
          PYTORCH_ENABLE_MPS_FALLBACK: "1",
          HF_HUB_OFFLINE: "1",
          PATH: `${CONDA_BIN}:${process.env.PATH}`,
        },
      }
    );

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Kokoro synthesis timed out after 3 hours"));
    }, 3 * 60 * 60 * 1000);

    let aborted = false;
    const handleAbort = () => {
      aborted = true;
      proc.kill("SIGKILL");
    };
    signal?.addEventListener("abort", handleAbort);

    let totalChunks = 0;
    const stdoutRl = createInterface({ input: proc.stdout });
    stdoutRl.on("line", (line) => {
      try {
        const data = JSON.parse(line);
        if (data.type === "chunks") {
          totalChunks = data.total;
          log(`Phonemized into ${totalChunks} chunks`);
        } else if (data.type === "progress") {
          const previewSuffix = chunkPreviewUrlBase ? ` — ${chunkPreviewUrlBase}/chunk-${String(data.chunk).padStart(3, "0")}.wav` : "";
          log(`Chunk ${data.chunk}/${data.totalChunks} — ${data.audioSeconds}s of audio${previewSuffix}`);
          onProgress(data.chunk, data.totalChunks);
        } else if (data.type === "done") {
          log(`Synthesis complete — ${data.audioSeconds}s of audio in ${data.chunks} chunks`);
        }
      } catch {}
    });

    let stderrBuf = "";
    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      stderrBuf += line + "\n";
      if (line.includes("Error") || line.includes("Traceback")) {
        log(`stderr: ${line.trim()}`);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      stdoutRl.close();
      stderrRl.close();
      signal?.removeEventListener("abort", handleAbort);
      // The script streams into <output>.partial and renames it only once the chapter is whole
      if (aborted || code !== 0) void rm(`${outputPath}.partial`, { force: true }).catch(() => {});
      if (aborted) {
        reject(new KokoroAbortedError());
        return;
      }
      if (code !== 0) {
        reject(new Error(`Kokoro synthesis failed: ${stderrBuf.trim()}`));
      } else if (stderrBuf.includes("Error")) {
        reject(new Error(`Kokoro synthesis failed: ${stderrBuf.trim()}`));
      } else {
        resolve();
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      stdoutRl.close();
      stderrRl.close();
      signal?.removeEventListener("abort", handleAbort);
      if (aborted) {
        reject(new KokoroAbortedError());
        return;
      }
      reject(err);
    });
  });
}
