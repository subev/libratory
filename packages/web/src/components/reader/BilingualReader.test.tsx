import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { BilingualReader } from "./BilingualReader.tsx";
import { BILINGUAL_FORMAT, readBilingualDocument, textRevision, wordAnchorAt, type BilingualLane, type BilingualPair } from "../../../../server/src/lib/bilingual-format.ts";
import { tokenize } from "../../../../server/src/lib/bilingual-segment.ts";
import { httpSource } from "../../lib/reader-source.ts";
import { listenPosition, wordHighlight } from "../../lib/bilingual-reading.ts";
import type { ReaderChapter } from "../../lib/reader-doc.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const lane = (text: string, language: string): BilingualLane => {
    const second = text.indexOf(" ") + 1;
    return { id: language, language, text, textRevision: textRevision(text),
      tokens: tokenize(text, { start: 0, end: text.length }, language).map((t) => ({ id: t.id, range: [t.start, t.end] })),
      narration: { audio: `${language}.m4a`, revision: "a".repeat(64), totalMs: 2000, qualityNotes: [],
        anchors: [0, second].flatMap((start, i) => [
          { kind: "passage", range: [start, start + second - 1], start: { ms: 200 + i * 800, method: "provider-word" }, end: { ms: 800 + i * 800, method: "provider-word" } },
          { kind: "word", range: [start, start + second - 2], start: { ms: 200 + i * 800, method: "provider-word" }, end: { ms: 800 + i * 800, method: "provider-word" } },
        ]) } };
  };
  const source = lane("so-called. so-called.", "en"), target = lane("soi-disant. soi-disant.", "fr");
  const pairs: BilingualPair[] = [0, 1].map((i) => ({ id: `p${i + 1}`, status: "matched", linksStatus: "ready",
    source: [i * 11, i * 11 + 10], target: [i * 12, i * 12 + 11],
    links: [1, 2].map((id) => ({ source: [i * 2 + id], target: [i * 2 + id] })) }));
  return readBilingualDocument({ format: BILINGUAL_FORMAT, chapterId: "test", key: "fr", tokenizer: "intl-segmenter-word/1", source, target, pairs });
}

function render(doc: ReturnType<typeof fixture>, ms: number) {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const chapter: ReaderChapter = { id: "test", i: 0, title: "Compound words", audio: "en.m4a", cues: null, text: null,
    durationMs: 2000, pageStart: null, pageEnd: null, mode: "text" };
  const manifest = { format: "p2af/1", book: { id: "test", title: "Test", author: null, language: "en", medianBodyPt: null, cover: null }, sources: [], pages: [], chapters: [chapter] };
  return parseHTML(renderToStaticMarkup(<MemoryRouter><BilingualReader doc={doc} source={httpSource("unused")} manifest={manifest}
    chapter={chapter} controls={null} onChapter={() => {}} onExit={() => {}} initialMs={ms} onPosition={() => {}} /></MemoryRouter>)).document;
}

it("renders both halves and both direct counterparts of the current repeated compound", () => {
  const doc = fixture(), document = render(doc, 1200);
  expect(Array.from(document.querySelectorAll('[data-testid="reader-word"]'), (node) => node.getAttribute("data-token")))
    .toEqual(["source:3", "source:4"]);
  expect(Array.from(document.querySelectorAll("button.underline"), (node) => node.getAttribute("data-token")))
    .toEqual(["target:3", "target:4"]);
  const pair = doc.pairs[1];
  if (!pair) throw new Error("Missing pair");
  expect(wordAnchorAt(doc.source, 1200)).toBe(wordAnchorAt(doc.source, 1300));
  expect(listenPosition(doc.source, pair, "source", 4)).toEqual({ ms: 1000, word: true });
});

it("keeps sentence fallback but no word or counterpart in gaps or zero-duration words", () => {
  const doc = fixture(), anchor = doc.source.narration?.anchors[3];
  if (!anchor) throw new Error("Missing anchor");
  anchor.end.ms = anchor.start.ms;
  for (const ms of [900, 1200]) {
    const document = render(doc, ms);
    expect(document.querySelector('[data-testid="text-cue-active"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="reader-word"], button.underline')).toHaveLength(0);
  }
});

it("constrains a spanning anchor to its current pair and does not expand links transitively", () => {
  const doc = fixture(), pair = doc.pairs[1], anchor = doc.source.narration?.anchors[3];
  if (!pair || !anchor) throw new Error("Missing fixture");
  anchor.range = [0, doc.source.text.length];
  pair.links = [{ source: [3], target: [3] }, { source: [4], target: [3, 4] }];
  expect(wordHighlight(doc.source, pair, "source", anchor)).toEqual({ speaking: [3, 4], linked: { source: [3, 4], target: [3, 4] } });
  anchor.range = [11, 13];
  expect(wordHighlight(doc.source, pair, "source", anchor)).toEqual({ speaking: [3], linked: { source: [3], target: [3] } });
  expect(wordHighlight(doc.source, null, "source", anchor).speaking).toEqual([]);
  pair.status = "uncertain";
  expect(wordHighlight(doc.source, pair, "source", anchor)).toEqual({ speaking: [3], linked: { source: [], target: [] } });
});
