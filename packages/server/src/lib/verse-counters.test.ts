import { expect, it } from "vitest";
import { cleanVerseCounters } from "./verse-counters.ts";
import { placeOrderedPage } from "./ocr-ordered-placement.ts";
import type { LlmPage, Reference } from "./ocr-llm.ts";
import type { Box } from "./word-alignment.ts";

function example(prefix = "25", margin = true) {
  const texts = [`${prefix} The verse begins`, "Another verse line", "The final verse", "Age 35 and note 5", "5.VII.1938" ];
  const lines = texts.map((text, i) => ({ id: i + 1, text, box: [i === 0 && margin ? 65 : 100, 100 + i * 20, 350, 112 + i * 20] as Box }));
  const page: LlmPage = { blocks: [{ type: "paragraph", text: texts.join("\n") }], furniture: [], continues: false, lineGroups: [lines] };
  const words = lines.flatMap((line) => line.text.split(" ").map((text, i) => ({ text, conf: 99, line: line.id,
    box: [line.box[0] + i * 40, line.box[1], line.box[0] + i * 40 + 25, line.box[3]] as Box })));
  const reference: Reference = { width: 1000, height: 1000, text: texts.join("\n"), words };
  const placed = placeOrderedPage(page, reference, { width: 1000, height: 1000 }, 0);
  return { page, reference, geometry: placed.geometry };
}
it("removes a measured multiple-of-five margin counter while keeping dates, ages and references", () => {
  const { page, reference, geometry } = example();
  const result = cleanVerseCounters(page, geometry);
  expect(result.removed.map((x) => x.text)).toEqual(["25"]);
  expect(result.page.blocks[0]?.text).toBe("The verse begins\nAnother verse line\nThe final verse\nAge 35 and note 5\n5.VII.1938");
  expect(page.blocks[0]?.text).toMatch(/^25 /);
  const refreshed = placeOrderedPage(result.page, reference, { width: 1000, height: 1000 }, 0);
  expect(refreshed.words.map((x) => x.text)).not.toContain("25");
  expect(refreshed.words.map((x) => x.text)).toContain("35");
  expect(cleanVerseCounters(result.page, refreshed.geometry).removed).toEqual([]);
});
it.each([["24", true], ["25", false], ["250.", true]])("preserves a non-counter %s (margin=%s)", (number, margin) => {
  const { page, geometry } = example(String(number), Boolean(margin));
  expect(cleanVerseCounters(page, geometry).page).toEqual(page);
});
it("preserves heading numbers even in the margin and refuses missing line evidence", () => {
  const { page, geometry } = example();
  const block = page.blocks[0];
  if (!block) throw new Error("Missing fixture block");
  block.type = "heading";
  expect(cleanVerseCounters(page, geometry).removed).toEqual([]);
  const { lineGroups: _groups, ...ordinary } = page;
  expect(() => cleanVerseCounters(ordinary, geometry)).toThrow("ordered line evidence");
});
it.each(["footnote", "metadata", "prose"] as const)("preserves a numbered %s even when its geometry resembles verse", (kind) => {
  const { page, geometry } = example("15");
  const block = page.blocks[0];
  if (!block) throw new Error("Missing fixture block");
  block.kind = kind;
  expect(cleanVerseCounters(page, geometry).removed).toEqual([]);
});
