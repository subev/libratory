import { expect, it } from "vitest";
import { cleanText } from "./extracted-text.ts";

it("reflows printed wraps within a block and rejoins Cyrillic and Latin split words", () => {
  expect(cleanText("На Велик-\nден се сговарят да кажат\nна царската дъщеря.")).toBe("На Великден се сговарят да кажат на царската дъщеря.");
  expect(cleanText("An inter-\r\n national trip.")).toBe("An international trip.");
  expect(cleanText("A soft\u00ad\nware example.")).toBe("A software example.");
});
it("keeps inline hyphens, numbers and punctuation and is idempotent", () => {
  const text = "по-голям — 35 г., 5.VII.1938; well-known.";
  expect(cleanText(text)).toBe(text);
  expect(cleanText(cleanText(" One\n two. "))).toBe("One two.");
});

it("preserves intentional verse and stanza breaks while reflowing prose", async () => {
  const { formatExtractedText } = await import("./extracted-text.ts");
  const text = " First verse\nsecond verse\n\nnext stanza ";
  expect(formatExtractedText(text, "verse")).toBe("First verse\nsecond verse\n\nnext stanza");
  expect(formatExtractedText(text, "prose")).toBe("First verse second verse next stanza");
});

it("joins a declared verse continuation without inventing a stanza and keeps source offsets", async () => {
  const { joinTextBlocks } = await import("./extracted-text.ts");
  const blocks = [
    { kind: "verse" as const, text: "Left\nverse" },
    { kind: "verse" as const, breakBefore: "line" as const, text: "Right\n\nNext stanza" },
    { kind: "furniture" as const, text: "181", included: false },
    { kind: "footnote" as const, text: "14 Note" },
  ];
  const joined = joinTextBlocks(blocks);
  expect(joined.text).toBe("Left\nverse\nRight\n\nNext stanza\n\n14 Note");
  expect(joined.spans.map((span) => joined.text.slice(span.start, span.end))).toEqual([blocks[0]?.text, blocks[1]?.text, blocks[3]?.text]);
  expect(joined.spans.map((span) => span.block)).toEqual([0, 1, 3]);
  expect(joinTextBlocks([{ text: "A" }, { text: "B" }]).text).toBe("A\n\nB");
});
