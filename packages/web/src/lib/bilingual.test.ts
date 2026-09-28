import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { BILINGUAL_FORMAT, bilingualReferences, linkedTokens, parseBilingualDocument, readBilingualDocument, switchNarration, textRevision, tokenAtTime, type BilingualDocument } from "../../../server/src/lib/bilingual-format.ts";
import { containerSource } from "./reader-source.ts";
import { readingDirection } from "./reading-lang.ts";

async function fixture(): Promise<BilingualDocument> {
  const sourceText = "turned it off", targetText = "כיבה אותו";
  return { format: BILINGUAL_FORMAT, chapterId: "chapter", key: "he", tokenizer: "fixture/1",
    source: { id: "original", language: "en", text: sourceText, textRevision: await textRevision(sourceText), tokens: [{ id: 0, range: [0, 6] }, { id: 1, range: [7, 9] }, { id: 2, range: [10, 13] }],
      narration: { revision: "a".repeat(64), audio: "../audio/original.m4a", totalMs: 2000, qualityNotes: [], anchors: [{ kind: "passage", range: [0, 13], start: { ms: 200, method: "provider-word" }, end: { ms: 1800, method: "provider-word" } }] } },
    target: { id: "he", language: "he", text: targetText, textRevision: await textRevision(targetText), tokens: [{ id: 0, range: [0, 4] }, { id: 1, range: [5, 9] }],
      narration: { revision: "b".repeat(64), audio: "audio/he.m4a", totalMs: 5000, qualityNotes: ["Unverified provider timing"], anchors: [{ kind: "passage", range: [0, 9], start: { ms: 2500, method: "provider-word" }, end: { ms: 4000, method: "provider-word" } }, { kind: "word", range: [0, 4], start: { ms: 2500, method: "provider-word" }, end: { ms: 2500, method: "provider-word" } }] } },
    pairs: [{ id: "p1", status: "matched", source: [0, 13], target: [0, 9], linksStatus: "ready", links: [{ source: [0, 2], target: [0] }, { source: [1], target: [1] }] }] };
}

describe("bilingual contract and playback", () => {
  it("uses the lane language for direction even when Hebrew starts with a Latin name", () => {
    expect(readingDirection("he")).toBe("rtl");
    expect(readingDirection("de")).toBe("ltr");
    expect(readingDirection("und")).toBe("auto");
  });
  it("ignores malformed optional references without breaking the ordinary reader", () => {
    const valid = { key: "he", language: "he", url: "bilingual/he.json" };
    expect(bilingualReferences({ wrong: true })).toEqual([]);
    expect(bilingualReferences(null)).toEqual([]);
    expect(bilingualReferences([null, { key: "he" }, valid])).toEqual([valid]);
  });
  it("hashes text consistently without requiring a secure browser context", () => {
    expect(textRevision("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("preserves a discontinuous expression and RTL text with stored IDs", async () => {
    const doc = readBilingualDocument(await fixture());
    const pair = doc.pairs[0];
    if (!pair) throw new Error("Missing fixture pair");
    expect(linkedTokens(pair, "source", 0)).toEqual({ source: [0, 2], target: [0] });
    expect(doc.target.text).toBe("כיבה אותו");
  });
  it("rejects stale text instead of retaining old token addresses", async () => {
    const doc = await fixture(); doc.target.text = "כיבה אותה";
    expect(() => readBilingualDocument(doc)).toThrow(/revision/);
  });
  it("rejects unknown and cross-pair token IDs", async () => {
    const doc = await fixture(); const link = doc.pairs[0]?.links[0];
    if (!link) throw new Error("Missing link");
    link.target = [100];
    expect(() => parseBilingualDocument(doc)).toThrow(/outside its pair/);
    doc.pairs = [
      { id: "p1", status: "matched", source: [0, 6], target: [0, 4], linksStatus: "ready", links: [{ source: [0], target: [1] }] },
      { id: "p2", status: "matched", source: [7, 13], target: [5, 9], linksStatus: "ready", links: [] },
    ];
    expect(() => parseBilingualDocument(doc)).toThrow(/outside its pair/);
  });
  it("rejects overlapping groups and text that disappeared between pairs", async () => {
    const doc = await fixture(), first = doc.pairs[0];
    if (!first) throw new Error("Missing pair");
    doc.pairs.push({ ...first, id: "p2" });
    expect(() => parseBilingualDocument(doc)).toThrow(/overlapping/);
    doc.pairs = [{ ...first, source: [1, 13], links: [] }];
    expect(() => parseBilingualDocument(doc)).toThrow(/unrepresented/);
  });
  it("does not split a UTF-16 surrogate pair", async () => {
    const doc = await fixture(); doc.source.text = String.fromCodePoint(0x1f600); doc.source.tokens = [{ id: 0, range: [0, 1] }];
    expect(() => parseBilingualDocument(doc)).toThrow(/token range/);
  });
  it("lands in the other recording's sentence without copying milliseconds", async () => {
    const doc = await fixture();
    expect(switchNarration(doc, "source", 1000)).toEqual({ side: "target", ms: 2500 });
    expect(switchNarration(doc, "source", 0)).toEqual({ side: "target", ms: 2500 });
    expect(switchNarration(doc, "source", 1900)).toEqual({ side: "target", ms: 2500 });
    expect(tokenAtTime(doc.source, 1900)).toBeNull();
  });
  it("does not move playback across an uncertain or missing counterpart", async () => {
    const doc = await fixture(), pair = doc.pairs[0];
    if (!pair) throw new Error("Missing pair");
    pair.status = "uncertain"; pair.links = [];
    expect(switchNarration(doc, "source", 1000)).toBeNull();
    pair.status = "source-only"; pair.target = null;
    expect(switchNarration(doc, "source", 1000)).toBeNull();
    pair.status = "matched"; pair.target = [0, 9]; doc.target.narration = null;
    expect(switchNarration(doc, "source", 1000)).toBeNull();
  });
  it("keeps the preceding sentence through silence without spanning an untimed passage", async () => {
    const doc = await fixture(), first = doc.pairs[0];
    if (!first || !doc.source.narration || !doc.target.narration) throw new Error("Missing fixture");
    doc.pairs = [{ ...first, source: [0, 6], target: [0, 4] }, { ...first, id: "p2", source: [7, 13], target: [5, 9] }];
    doc.source.narration.anchors = [
      { kind: "passage", range: [0, 6], start: { ms: 200, method: "provider-word" }, end: { ms: 800, method: "provider-word" } },
      { kind: "passage", range: [7, 13], start: { ms: 1000, method: "provider-word" }, end: { ms: 1800, method: "provider-word" } },
    ];
    doc.target.narration.anchors = [
      { kind: "passage", range: [0, 4], start: { ms: 2500, method: "provider-word" }, end: { ms: 3000, method: "provider-word" } },
      { kind: "passage", range: [5, 9], start: { ms: 3500, method: "provider-word" }, end: { ms: 4000, method: "provider-word" } },
    ];
    expect(switchNarration(doc, "source", 900)).toEqual({ side: "target", ms: 2500 });
    expect(switchNarration(doc, "source", 1100)).toEqual({ side: "target", ms: 3500 });
    doc.source.narration.anchors = doc.source.narration.anchors.slice(0, -1);
    expect(switchNarration(doc, "source", 1900)).toBeNull();
  });
  it("does not highlight a zero-duration word or invent a word between anchors", async () => {
    const doc = await fixture();
    expect(tokenAtTime(doc.target, 2500)).toBeNull();
    expect(tokenAtTime(doc.target, 3000)).toBeNull();
  });
  it("rejects reversed or out-of-recording timestamps", async () => {
    const doc = await fixture(), anchor = doc.target.narration?.anchors[0];
    if (!anchor) throw new Error("Missing anchor");
    anchor.start = { ms: 4500, method: "provider-word" };
    expect(() => parseBilingualDocument(doc)).toThrow(/reversed/);
    anchor.start = { ms: 2000, method: "provider-word" }; anchor.end = { ms: 9000, method: "provider-word" };
    expect(() => parseBilingualDocument(doc)).toThrow(/outside recording/);
  });
});

describe("optional bilingual EPUB resources", () => {
  it("loads nested document URLs relative to book.json, keeps ordinary reading and releases both audio URLs", async () => {
    const doc = await fixture(), dir = await mkdtemp(path.join(tmpdir(), "bilingual-reader-"));
    try {
      for (const name of ["OEBPS/p2af/bilingual", "OEBPS/p2af/audio", "OEBPS/audio"]) await mkdir(path.join(dir, name), { recursive: true });
      await writeFile(path.join(dir, "OEBPS/p2af/book.json"), JSON.stringify({ format: "p2af/1", sources: [], chapters: [{ id: "chapter", audio: "../audio/original.m4a", bilingual: [{ key: "he", language: "he", url: "bilingual/he.json" }] }] }));
      await writeFile(path.join(dir, "OEBPS/p2af/bilingual/he.json"), JSON.stringify(doc));
      await writeFile(path.join(dir, "OEBPS/p2af/bilingual/future.json"), JSON.stringify({ ...doc, format: "p2af-bilingual/999" }));
      const missingAudio = structuredClone(doc);
      if (missingAudio.target.narration) missingAudio.target.narration.audio = "audio/missing.m4a";
      await writeFile(path.join(dir, "OEBPS/p2af/bilingual/missing.json"), JSON.stringify(missingAudio));
      await writeFile(path.join(dir, "OEBPS/audio/original.m4a"), "original");
      await writeFile(path.join(dir, "OEBPS/p2af/audio/he.m4a"), "translation");
      const archive = path.join(dir, "book.epub");
      await promisify(execFile)("zip", ["-q", "-0", "-r", archive, "OEBPS"], { cwd: dir });
      const source = await containerSource(new Blob([await readFile(archive)]));
      expect((await source.manifest()).format).toBe("p2af/1");
      expect(source.resolve("audio/he.m4a")).toBeUndefined();
      await expect(source.bilingual("bilingual/future.json")).rejects.toThrow();
      expect(source.resolve("../audio/original.m4a")).toBeDefined();
      const textOnly = await source.bilingual("bilingual/missing.json");
      expect(textOnly.target.text).toBe(doc.target.text);
      expect(textOnly.target.narration).toBeNull();
      await source.bilingual("bilingual/he.json");
      const url = source.resolve("audio/he.m4a");
      if (!url) throw new Error("Secondary audio missing");
      expect(await (await fetch(url)).text()).toBe("translation");
      source.close();
      expect(source.resolve("audio/he.m4a")).toBeUndefined();
      await expect(fetch(url)).rejects.toThrow();
      await expect(source.bilingual("bilingual/he.json")).rejects.toThrow(/closed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it("rejects token boundaries inside combining marks and joined emoji", async () => {
  for (const text of ["שָ", "á", String.fromCodePoint(0x1F469, 0x200D, 0x1F4BB)]) {
    const doc = await fixture();
    doc.source.text = text;
    doc.source.tokens = [{ id: 0, range: [0, 1] }];
    expect(() => parseBilingualDocument(doc)).toThrow("token range");
  }
});
