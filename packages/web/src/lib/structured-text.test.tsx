import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TextBody, CueTranscript } from "../components/reader/CueTranscript.tsx";
import type { ReaderText } from "./reader-doc.ts";

const document: ReaderText = { format: "p2af/1", text: "Left\nRight\n\n14 Note", blocks: [
  { start: 0, end: 4, kind: "verse" }, { start: 5, end: 10, kind: "verse", breakBefore: "line" },
  { start: 12, end: 19, kind: "footnote" },
] };
it("renders semantic footnotes and verse continuity in the actual reader components", () => {
  const html = renderToStaticMarkup(<TextBody text={document.text} document={document} />);
  expect(html).toContain('aria-label="Footnotes"');
  expect(html).toContain('role="doc-footnote"');
  expect(html).toContain('class="mb-0"');
  expect(html).toContain("14 Note");
  const spoken = renderToStaticMarkup(<CueTranscript ms={60} onSeek={() => {}} cues={{ format: "p2af/1", totalMs: 100, granularity: "word", text: document, cues: [
    { t: [0, 100], c: 0, s: "Left Right", range: [0, 10], w: [[0, 50, "Left"], [50, 100, "Right"]] },
  ] }} />);
  expect(spoken).toContain('data-testid="reader-word">Right</mark>');
  expect(spoken).toContain("14 Note");
});
