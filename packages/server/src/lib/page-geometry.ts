import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { env } from "../env.ts";
import { describeError } from "./errors.ts";
import type { MarkerSource } from "./marker-sources.ts";

const GEOMETRY_SCRIPT = scriptPath("page_geometry.py");
const GEOMETRY_FILE = "geometry.json";

export type { Rect } from "./reader-format.ts";
import type { Rect } from "./reader-format.ts";
import { scriptPath } from "./paths.ts";

export type GeometryLine = {
  b: [number, number, number, number];
  t: string;
  // x edge of every character, length t.length + 1; absent when the page has no text layer
  xs?: number[];
};

export type GeometryPage = {
  i: number;
  w: number;
  h: number;
  rot: number;
  cropOffset: [number, number];
  lines: GeometryLine[];
};

// 3 split pdftext lines that merged two printed rows; 4 grows a line box down to the ink so
// descenders sit inside it. An older sidecar is still served — its boxes are short, not wrong —
// while a current one is written behind it, so nobody waits out a re-extraction to read a page.
const CURRENT_VERSION = 4;
const OLDEST_USABLE_VERSION = 3;

export type SourceGeometry = { version: number; pages: GeometryPage[] };

export type PageLayout = { content: Rect; columns: Rect[] };

// A gutter narrower than this is letter spacing, not a column break
const MIN_GUTTER_FRACTION = 0.04;
// A heading spanning both columns crosses the gutter; a handful of those is still a gutter
const GUTTER_TOLERANCE_FRACTION = 0.05;
const MIN_COLUMN_LINE_FRACTION = 0.25;
const MIN_LINES_TO_SPLIT = 8;
// Two splits is four columns, past which the page is a table, not prose
const MAX_SPLIT_DEPTH = 2;

function geometryPath(source: MarkerSource): string {
  return path.join(source.outDir, GEOMETRY_FILE);
}

const running = new Map<string, Promise<void>>();

export async function ensureSourceGeometry(source: MarkerSource): Promise<SourceGeometry | null> {
  const target = geometryPath(source);
  const existing = await readGeometry(target);
  if (existing) {
    // An upgrade that cannot succeed — the source PDF moved, the Python environment is gone — must
    // not be attempted again on every request. The old sidecar still reads, so nothing else says stop.
    if (existing.version < CURRENT_VERSION && !unupgradable.has(target)) {
      void regenerate(source, target).catch((error: unknown) => {
        unupgradable.add(target);
        console.error(`Page geometry for ${source.filename}: ${describeError(error)}`);
      });
    }
    return existing;
  }

  await regenerate(source, target);
  return readGeometry(target);
}

const unupgradable = new Set<string>();

// One run per sidecar however many readers ask for it at once
function regenerate(source: MarkerSource, target: string): Promise<void> {
  let run = running.get(target);
  if (!run) {
    run = generate(source.pdfPath, target).finally(() => running.delete(target));
    running.set(target, run);
  }
  return run;
}

// A sidecar runs to 14 MB on a 700-page book, and every reader request wants one. Parsing that
// per request blocks the loop for tens of milliseconds, so it is held until the file changes.
const parsed = new Map<string, { mtimeMs: number; geometry: SourceGeometry }>();

async function readGeometry(target: string): Promise<SourceGeometry | null> {
  try {
    const { size, mtimeMs } = await stat(target);
    if (size === 0) return null;

    const cached = parsed.get(target);
    if (cached?.mtimeMs === mtimeMs) return cached.geometry;

    const geometry = JSON.parse(await readFile(target, "utf-8")) as SourceGeometry;
    if (!(geometry?.version >= OLDEST_USABLE_VERSION) || !Array.isArray(geometry.pages)) return null;
    parsed.set(target, { mtimeMs, geometry });
    return geometry;
  } catch {
    return null;
  }
}

function generate(pdfPath: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      path.join(env.CONDA_ENV_PATH, "python"),
      [GEOMETRY_SCRIPT, "--pdf", pdfPath, "--out", target],
      { env: { ...process.env, HF_HUB_OFFLINE: "1", PATH: `${env.CONDA_ENV_PATH}:${process.env.PATH}` } },
    );

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Page geometry extraction timed out after 10 minutes"));
    }, 10 * 60_000);

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Page geometry extraction failed: ${stderr.trim()}`));
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export function pageLayout(page: GeometryPage): PageLayout {
  const boxes = page.lines.map((line) => line.b);
  if (boxes.length === 0) {
    const whole: Rect = [0, 0, page.w, page.h];
    return { content: whole, columns: [whole] };
  }

  const content = union(boxes);
  return { content, columns: splitColumns(boxes, content, page.w) };
}

function splitColumns(boxes: GeometryLine["b"][], content: Rect, pageWidth: number, depth = 0): Rect[] {
  const gutter = depth >= MAX_SPLIT_DEPTH ? null : findGutter(boxes, content, pageWidth);
  if (gutter === null) return [content];

  const left = boxes.filter((box) => midpoint(box) < gutter);
  const right = boxes.filter((box) => midpoint(box) >= gutter);
  if (left.length === 0 || right.length === 0) return [content];

  // Clamping at the gutter keeps a spanning heading from widening the column it fell into
  const leftBox = clampRight(union(left), gutter);
  const rightBox = clampLeft(union(right), gutter);
  return [
    ...splitColumns(left, leftBox, pageWidth, depth + 1),
    ...splitColumns(right, rightBox, pageWidth, depth + 1),
  ];
}

// The widest run of near-empty vertical space with text on both sides of it
function findGutter(boxes: GeometryLine["b"][], content: Rect, pageWidth: number): number | null {
  if (boxes.length < MIN_LINES_TO_SPLIT || content[2] <= 0) return null;

  const bins = Math.ceil(content[2]);
  const coverage = new Int32Array(bins);
  for (const box of boxes) {
    const from = Math.max(0, Math.floor(box[0] - content[0]));
    const to = Math.min(bins, Math.ceil(box[2] - content[0]));
    for (let i = from; i < to; i++) coverage[i] = (coverage[i] ?? 0) + 1;
  }

  const tolerance = Math.max(1, Math.round(boxes.length * GUTTER_TOLERANCE_FRACTION));
  const minWidth = pageWidth * MIN_GUTTER_FRACTION;
  let best: { start: number; end: number } | null = null;
  let runStart = -1;

  for (let i = 0; i <= bins; i++) {
    const empty = i < bins && (coverage[i] ?? 0) <= tolerance;
    if (empty && runStart < 0) runStart = i;
    if (!empty && runStart >= 0) {
      const width = i - runStart;
      // A run touching either edge is a margin, not a gutter
      if (runStart > 0 && i < bins && width >= minWidth && (!best || width > best.end - best.start)) {
        best = { start: runStart, end: i };
      }
      runStart = -1;
    }
  }
  if (!best) return null;

  const split = content[0] + (best.start + best.end) / 2;
  const before = boxes.filter((box) => midpoint(box) < split).length;
  const minLines = boxes.length * MIN_COLUMN_LINE_FRACTION;
  return before >= minLines && boxes.length - before >= minLines ? split : null;
}

function midpoint(box: GeometryLine["b"]): number {
  return (box[0] + box[2]) / 2;
}

function clampRight(rect: Rect, x: number): Rect {
  return [rect[0], rect[1], Math.max(0, Math.min(rect[0] + rect[2], x) - rect[0]), rect[3]];
}

function clampLeft(rect: Rect, x: number): Rect {
  const left = Math.max(rect[0], x);
  return [left, rect[1], Math.max(0, rect[0] + rect[2] - left), rect[3]];
}

function union(boxes: GeometryLine["b"][]): Rect {
  const [head] = boxes;
  if (!head) return [0, 0, 0, 0];
  let [x0, y0, x1, y1] = head;
  for (const box of boxes) {
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

// Line height, not the reported font size (some PDFs say 1pt or 53pt), weighted by text length
export function medianBodyPt(pages: GeometryPage[]): number | null {
  const lines: { height: number; weight: number }[] = [];
  let total = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.t.length === 0) continue;
      lines.push({ height: line.b[3] - line.b[1], weight: line.t.length });
      total += line.t.length;
    }
  }
  if (total === 0) return null;

  lines.sort((a, b) => a.height - b.height);
  let seen = 0;
  for (const line of lines) {
    seen += line.weight;
    if (seen >= total / 2) return Math.round(line.height * 10) / 10;
  }
  return null;
}
