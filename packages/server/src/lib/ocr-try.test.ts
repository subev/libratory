import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyDoubt, detectScript, parseTsvLines, renderTryPage, tesseractPage, type TryWord } from "./ocr-try.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const BOOK = "00000000-0000-4000-8000-00000000try1";

afterAll(async () => {
  await rm(path.resolve("data/tmp", BOOK), { recursive: true, force: true });
});

const word = (x0: number, conf: number, lastOnLine = false): TryWord => ({ text: "w", conf, x0, x1: x0 + 20, y0: 0, y1: 10, lastOnLine });

describe("classifyDoubt", () => {
  it("calls a page clean below the garbled share", () => {
    const words = [...Array.from({ length: 19 }, (_, i) => word(i * 25, 95)), word(475, 30)];
    expect(classifyDoubt(words, 500)).toEqual({ kind: "clean", count: 1 });
  });

  it("names the edge band when the doubted words sit at one margin, and only says last-word when it is true", () => {
    const good = Array.from({ length: 10 }, (_, i) => word(i * 30, 95));
    const edge = [word(420, 40, true), word(440, 35, true), word(460, 20, true), word(470, 50, true)];
    expect(classifyDoubt([...good, ...edge], 500)).toEqual({ kind: "edge", count: 4, side: "right", bandPct: 16, allLastWords: true });
    const mixed = [...good, ...edge.map((w, i) => ({ ...w, lastOnLine: i !== 0 }))];
    expect(classifyDoubt(mixed, 500)).toMatchObject({ kind: "edge", allLastWords: false });
  });

  it("calls scattered doubt scattered", () => {
    const words = [word(10, 30), word(150, 95), word(250, 40), word(300, 95), word(380, 30), word(480, 95)];
    expect(classifyDoubt(words, 500)).toEqual({ kind: "scattered", count: 3 });
  });
});

describe("parseTsvLines", () => {
  it("groups words into lines and marks the last word of each", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "4\t1\t1\t1\t1\t0\t0\t0\t100\t10\t-1\t",
      "5\t1\t1\t1\t1\t1\t10\t10\t30\t12\t96.5\tHello",
      "5\t1\t1\t1\t1\t2\t50\t10\t30\t12\t40.0\tworld",
      "5\t1\t1\t1\t2\t1\t10\t30\t30\t12\t88.0\tAgain",
    ].join("\n");
    const lines = parseTsvLines(tsv);
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "Again"]);
    expect(lines[0]?.words.map((w) => w.lastOnLine)).toEqual([false, true]);
    expect(lines[0]?.words[0]).toMatchObject({ conf: 96.5, x0: 4.8, y0: 4.8 });
  });
});

describe("a page through the try path", () => {
  it("renders once, names the script, and reads the page with word geometry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ocr-try-"));
    try {
      const first = await renderTryPage(BOOK, 0, FIXTURE, 1);
      const again = await renderTryPage(BOOK, 0, FIXTURE, 1);
      expect(again.png).toBe(first.png);
      expect(first.width).toBeGreaterThan(100);
      expect((await stat(first.png)).size).toBeGreaterThan(1000);
      expect(await detectScript(BOOK, 0, FIXTURE, 1)).toBe("Latin");

      const read = await tesseractPage(first.png, "eng", first.width);
      expect(read.lines.length).toBeGreaterThan(3);
      expect(read.lines.flatMap((l) => l.words).every((w) => w.conf >= 0 && w.conf <= 100 && w.x1 <= first.width + 1)).toBe(true);
      expect(read.confidence).toBeGreaterThan(0.5);
      expect(read.callout.kind).toBe("clean");
      expect(read.elapsedMs).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
