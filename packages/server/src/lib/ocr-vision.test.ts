import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { parseVisionTable, readVisionWords, visionBinary, visionLanguage } from "./ocr-vision.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("visionLanguage", () => {
  it("uses the language's own recogniser when Vision has one, else the alphabet's, and says which", () => {
    expect(visionLanguage("en", null)).toEqual({ code: "en-US", native: true });
    expect(visionLanguage("bg", null)).toEqual({ code: "ru-RU", native: false });
    expect(visionLanguage(null, "Cyrillic")).toEqual({ code: "ru-RU", native: false });
    expect(visionLanguage("hu", null)).toEqual({ code: "en-US", native: false });
    expect(visionLanguage(null, null)).toBeNull();
  });
});

describe("parseVisionTable", () => {
  it("reads the size row and the word rows, numbering lines the way the tool does", () => {
    const page = parseVisionTable("#size\t1065\t1600\nОт\t156\t1399\t184\t1428\t50\t3\nтази\t186\t1400\t238\t1430\t50\t3\nспоменат:\t688\t1425\t807\t1457\t50\t4\n");
    expect(page.width).toBe(1065);
    expect(page.height).toBe(1600);
    expect(page.words).toEqual([
      { text: "От", box: [156, 1399, 184, 1428], conf: 50, line: 3 },
      { text: "тази", box: [186, 1400, 238, 1430], conf: 50, line: 3 },
      { text: "споменат:", box: [688, 1425, 807, 1457], conf: 50, line: 4 },
    ]);
    expect(page.text).toBe("От тази\nспоменат:\n");
    expect(parseVisionTable("#size\t10\t10\n")).toEqual({ words: [], text: "", width: 10, height: 10 });
    // A row without a line index is skipped rather than starting a new line for every word after it
    expect(parseVisionTable("#size\t10\t10\nа\t1\t1\t2\t2\t50\t0\nб\t3\t1\t4\t2\t50\tx\nв\t5\t1\t6\t2\t50\t0\n").text).toBe("а в\n");
  });
});

describe("readVisionWords", () => {
  it.skipIf(process.platform !== "darwin")("boxes the fixture's words where Tesseract boxes them", async () => {
    const binary = await visionBinary();
    expect(binary).not.toBeNull();
    const dir = await mkdtemp(path.join(tmpdir(), "vision-"));
    dirs.push(dir);
    await execFileAsync("pdftoppm", ["-scale-to", "1600", "-jpeg", "-gray", FIXTURE, path.join(dir, "pg")]);
    const image = path.join(dir, (await readdir(dir)).find((f) => f.endsWith(".jpg"))!);
    const page = await readVisionWords(binary!, image, "en-US");
    expect(page.width).toBe(1133);
    expect(page.height).toBe(1600);
    const chapter = page.words.find((w) => w.text === "Chapter")!;
    const voyage = page.words.find((w) => w.text === "Voyage")!;
    // Tesseract reads the same render as Chapter [139, 136, 278, 172] and Voyage [405, 136, 532, 172]
    expect(chapter.box.map((v, i) => Math.abs(v - [139, 136, 278, 172][i]!) < 20).every(Boolean)).toBe(true);
    expect(voyage.box.map((v, i) => Math.abs(v - [405, 136, 532, 172][i]!) < 20).every(Boolean)).toBe(true);
    expect(voyage.line).toBe(chapter.line);
    expect(page.text.startsWith("Chapter 1. The Voyage Begins")).toBe(true);
  }, 120_000);
});
