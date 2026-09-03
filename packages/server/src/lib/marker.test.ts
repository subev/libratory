import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findMarkerJson, pickNumberedChapterIndices, type FlatBlock } from "./marker.ts";

function heading(text: string, page: number, level = 1): FlatBlock {
  return { type: "SectionHeader", text, hierarchy: null, level, page, included: true };
}

function paragraph(page: number): FlatBlock {
  return { type: "Text", text: "Some body text.", hierarchy: null, page, included: true };
}

describe("pickNumberedChapterIndices", () => {
  it("picks a spread-out Chapter N sequence and ignores other headings", () => {
    const blocks = [
      heading("Introduction", 2),
      heading("Chapter 1 Critiquing Design", 10),
      paragraph(11),
      heading("Practice Questions", 12),
      heading("Chapter 2 Designing a Desktop Application", 20),
      paragraph(21),
      heading("Answers", 22),
      heading("Chapter 3 Getting Technical", 30),
    ];

    expect(pickNumberedChapterIndices(blocks)).toEqual([1, 4, 7]);
  });

  it("excludes ToC listing pages that stack several chapter entries", () => {
    const blocks = [
      heading("Chapter 1 One", 3),
      heading("Chapter 2 Two", 3),
      heading("Chapter 3 Three", 3),
      heading("Chapter 4 Four", 3),
      heading("Chapter 1 One", 10),
      heading("Chapter 2 Two", 20),
      heading("Chapter 3 Three", 30),
      heading("Chapter 4 Four", 40),
    ];

    expect(pickNumberedChapterIndices(blocks)).toEqual([4, 5, 6, 7]);
  });

  it("keeps the body heading when a straggler ToC entry duplicates its number", () => {
    const blocks = [
      heading("Chapter 1 One", 2),
      heading("Chapter 2 Two", 3),
      heading("Chapter 1 One", 10),
      heading("Chapter 2 Two", 20),
      heading("Chapter 3 Three", 30),
    ];

    expect(pickNumberedChapterIndices(blocks)).toEqual([2, 3, 4]);
  });

  it("keeps body chapters when an endnotes section repeats every chapter number", () => {
    const blocks: FlatBlock[] = [];
    const bodyIndices: number[] = [];
    const bodyPages = [14, 32, 74, 119, 179, 214, 256, 316, 380];
    bodyPages.forEach((page, i) => {
      bodyIndices.push(blocks.length);
      blocks.push(heading(`Chapter ${i + 1} Title ${i + 1}`, page));
      for (let p = page + 1; p < page + 6; p++) blocks.push(paragraph(p));
    });
    const notesPages = [434, 437, 441, 446, 451, 454, 457, 461, 471];
    notesPages.forEach((page, i) => {
      blocks.push(heading(`Chapter ${i + 1}: Title ${i + 1}`, page));
      blocks.push(paragraph(page));
    });

    expect(pickNumberedChapterIndices(blocks)).toEqual(bodyIndices);
  });

  it("supports roman numerals and Bulgarian глава headings", () => {
    const roman = [
      heading("Chapter I The Beginning", 5),
      heading("Chapter IV The Middle", 15),
      heading("Chapter IX The End", 25),
    ];
    expect(pickNumberedChapterIndices(roman)).toEqual([0, 1, 2]);

    const bulgarian = [
      heading("Глава 1 Начало", 5),
      heading("Глава 2 Среда", 15),
      heading("Глава 3 Край", 25),
    ];
    expect(pickNumberedChapterIndices(bulgarian)).toEqual([0, 1, 2]);

    const sections = [
      heading("Раздел I Приемане и отписване", 2),
      heading("Раздел II Организация", 6),
      heading("Раздел III Хранене", 9),
    ];
    expect(pickNumberedChapterIndices(sections)).toEqual([0, 1, 2]);
  });

  it("keeps the chapter run when part headings interleave", () => {
    const blocks = [
      heading("Part 1 Foundations", 5),
      heading("Chapter 1 One", 6),
      heading("Chapter 2 Two", 16),
      heading("Part 2 Applications", 25),
      heading("Chapter 3 Three", 26),
      heading("Chapter 4 Four", 36),
    ];

    expect(pickNumberedChapterIndices(blocks)).toEqual([1, 2, 4, 5]);
  });

  it("drops out-of-order numbers instead of failing", () => {
    const blocks = [
      heading("Chapter 1 One", 10),
      heading("Chapter 5 Listing straggler", 12),
      heading("Chapter 2 Two", 20),
      heading("Chapter 3 Three", 30),
    ];

    expect(pickNumberedChapterIndices(blocks)).toEqual([0, 2, 3]);
  });

  it("returns empty for fewer than three numbered chapters or excluded blocks", () => {
    expect(
      pickNumberedChapterIndices([heading("Chapter 1 One", 10), heading("Chapter 2 Two", 20)])
    ).toEqual([]);

    const excluded = [
      { ...heading("Chapter 1 One", 10), included: false },
      { ...heading("Chapter 2 Two", 20), included: false },
      { ...heading("Chapter 3 Three", 30), included: false },
    ];
    expect(pickNumberedChapterIndices(excluded)).toEqual([]);
  });
});


describe("findMarkerJson", () => {
  async function outDir(files: Record<string, string[]>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "marker-out-"));
    for (const [dir, names] of Object.entries(files)) {
      const target = dir === "." ? root : path.join(root, dir);
      if (dir !== ".") await mkdir(target, { recursive: true });
      for (const name of names) await writeFile(path.join(target, name), "{}");
    }
    return root;
  }

  it("takes the json that has marker's own _meta sibling", async () => {
    const root = await outDir({ ".": ["book.json", "book_meta.json"] });
    expect(await findMarkerJson(root)).toBe(path.join(root, "book.json"));
  });

  // The reader writes geometry.json into marker's own output directory the first time a book is
  // opened. It used to win, because it is a .json that is not a _meta.json — and every book anyone
  // had read lost its structure view and both Propose buttons to "extraction output missing".
  it("ignores the reader's geometry.json and keeps looking", async () => {
    const root = await outDir({ ".": ["geometry.json"], book: ["book.json", "book_meta.json"] });
    expect(await findMarkerJson(root)).toBe(path.join(root, "book", "book.json"));
  });

  it("still finds marker's output one directory down", async () => {
    const root = await outDir({ book: ["book.json", "book_meta.json"] });
    expect(await findMarkerJson(root)).toBe(path.join(root, "book", "book.json"));
  });

  it("refuses a directory that only holds someone else's json", async () => {
    const root = await outDir({ ".": ["geometry.json"] });
    await expect(findMarkerJson(root)).rejects.toThrow(/did not produce a JSON output file/);
  });
});
