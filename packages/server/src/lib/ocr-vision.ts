import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { env } from "../env.ts";
import { ExtractAbortedError } from "./marker.ts";
import type { OcrPage, OcrWord } from "./ocr-tesseract.ts";
import { scriptPath } from "./paths.ts";

const execFileAsync = promisify(execFile);

// Apple's Vision text recogniser — the OCR behind Live Text — through scripts/vision-words.swift.
// Its word boxes follow the skew of a photographed line, and it read the clipped, tilted lines of
// the POC book's page 17 that Tesseract's layout analysis dropped whole: matched share 75 → 84 on
// that page, 70 → 80 on the footnote page, in half a second a page against Tesseract's three.
// macOS only; elsewhere the Tesseract TSV stays the source of boxes.

const BINARY = "vision-words";

// Vision's recognisers by ISO-639-1 code. A language without one is read by the nearest
// recogniser for its alphabet — Bulgarian in Russian mode — with correction off, so the letters
// on the page come back and only the few forms Russian lacks are misread. The fuzzy alignment
// forgives that; the exact-word fidelity check would not, hence `native`.
const NATIVE: Record<string, string> = {
  en: "en-US", fr: "fr-FR", it: "it-IT", de: "de-DE", es: "es-ES", pt: "pt-BR", zh: "zh-Hans", ko: "ko-KR", ja: "ja-JP",
  ru: "ru-RU", uk: "uk-UA", th: "th-TH", vi: "vi-VT", ar: "ar-SA", tr: "tr-TR", id: "id-ID", cs: "cs-CZ", da: "da-DK",
  nl: "nl-NL", no: "no-NO", nb: "nb-NO", nn: "nn-NO", ms: "ms-MY", pl: "pl-PL", ro: "ro-RO", sv: "sv-SE",
};
const BY_SCRIPT: Record<string, string> = { Cyrillic: "ru-RU", Latin: "en-US", Han: "zh-Hans", Arabic: "ar-SA", Hangul: "ko-KR", Japanese: "ja-JP", Thai: "th-TH" };
const CYRILLIC = new Set(["bg", "mk", "sr", "be", "kk", "ky", "mn", "tg", "tt", "ba", "cv"]);

export type VisionLanguage = { code: string; native: boolean };

/** The recogniser for a book's language, or for the page's script when the language has none; null when neither is known. */
export function visionLanguage(language: string | null, script: string | null): VisionLanguage | null {
  if (language && NATIVE[language]) return { code: NATIVE[language], native: true };
  const inferred = script ?? (language && CYRILLIC.has(language) ? "Cyrillic" : language ? "Latin" : null);
  const code = inferred ? BY_SCRIPT[inferred] : null;
  return code ? { code, native: false } : null;
}

const exists = (p: string) => stat(p).then((s) => s, () => null);

let located: Promise<string | null> | null = null;

// The desktop app carries the binary beside its other tools, on the PATH the server gets. In
// development it is compiled once from the source beside the Python scripts, and again when that
// source is newer; no Swift toolchain means no Vision, not an error.
export function visionBinary(): Promise<string | null> {
  return (located ??= locate());
}

async function locate(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const onPath = await execFileAsync("which", [BINARY]).then((r) => r.stdout.trim() || null, () => null);
  if (onPath) return onPath;
  const built = path.resolve(env.DATA_DIR, "bin", BINARY);
  const source = await exists(scriptPath("vision-words.swift"));
  const binary = await exists(built);
  if (binary && (!source || source.mtimeMs <= binary.mtimeMs)) return built;
  if (!source) return null;
  try {
    await mkdir(path.dirname(built), { recursive: true });
    await execFileAsync("bash", [scriptPath("build-vision-words.sh"), built], { timeout: 300_000 });
    return built;
  } catch {
    return null;
  }
}

// The tool's table: "#size<TAB>w<TAB>h", then text, x0, y0, x1, y1, confidence, line per word.
export function parseVisionTable(table: string): OcrPage {
  const words: OcrWord[] = [];
  let text = "";
  let width: number | null = null;
  let height: number | null = null;
  let line = -1;
  for (const row of table.split("\n")) {
    const c = row.split("\t");
    if (c[0] === "#size") {
      width = Number(c[1]) || null;
      height = Number(c[2]) || null;
      continue;
    }
    if (c.length < 7 || !c[0]) continue;
    const at = Number(c[6]);
    if (!Number.isInteger(at)) continue;
    if (at !== line) {
      if (line >= 0) text += "\n";
      line = at;
    } else {
      text += " ";
    }
    text += c[0];
    words.push({ text: c[0], box: [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])], conf: Number(c[5]), line: at });
  }
  return { words, text: text ? `${text}\n` : "", width, height };
}

export async function readVisionWords(binary: string, image: string, language: string, signal?: AbortSignal): Promise<OcrPage> {
  if (signal?.aborted) throw new ExtractAbortedError();
  const { stdout } = await execFileAsync(binary, [image, language], { signal, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }).catch((err: NodeJS.ErrnoException) => {
    if (signal?.aborted) throw new ExtractAbortedError();
    throw err;
  });
  return parseVisionTable(stdout);
}
