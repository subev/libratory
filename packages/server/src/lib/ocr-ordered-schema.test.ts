import { expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { makeOrderedReader } from "./ocr-line-order.ts";
import { STANDARD_EXTRACTION } from "./extraction-presets.ts";

const lines = [{ id: 1, text: "", box: [100, 100, 200, 120] as [number, number, number, number] }];
const order = { groups: [{ section: 0, kind: "furniture", breakBefore: "paragraph", lineIds: [1] }] };
const response = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  warnings: [],
});

it("parses a real structured response for an image-confirmed empty detection", async () => {
  const model = new MockLanguageModelV4({ doGenerate: [response(order), response({ blocks: [{ group: 0, type: "other", text: "" }] })] });
  const result = await makeOrderedReader(model, STANDARD_EXTRACTION)(Buffer.from("image"), "image/png", lines, new AbortController().signal);
  expect(result.page.blocks).toEqual([{ type: "other", text: "", kind: "furniture" }]);
  expect(result.page.lineGroups).toEqual([lines]);
  expect(model.doGenerateCalls).toHaveLength(2);
});

it("retains raw output and schema details when the SDK rejects a transcription", async () => {
  const invalid = { blocks: [{ group: "wrong", type: "other", text: "" }] };
  const model = new MockLanguageModelV4({ doGenerate: [response(order), response(invalid)] });
  await expect(makeOrderedReader(model, STANDARD_EXTRACTION)(Buffer.from("image"), "image/png", lines, new AbortController().signal))
    .rejects.toMatchObject({ message: expect.stringContaining("blocks.0.group"), diagnostic: { stage: "transcription", order, response: JSON.stringify(invalid), causes: expect.arrayContaining([expect.stringContaining('"group"')]) } });
  expect(model.doGenerateCalls).toHaveLength(2);
});

it.each(["verse", "prose", "footnote", "metadata", "heading", "list", "furniture"] as const)("uses the ordered %s kind when transcription echoes it as a type", async (kind) => {
  const source = [{ ...lines[0], id: 1, text: "First\nSecond", box: [100, 100, 200, 120] as [number, number, number, number] }];
  const ordered = { groups: [{ section: 0, kind, breakBefore: "paragraph", lineIds: [1] }] };
  const model = new MockLanguageModelV4({ doGenerate: [response(ordered), response({ blocks: [{ group: 0, type: kind, text: "First\nSecond" }] })] });
  const result = await makeOrderedReader(model, STANDARD_EXTRACTION)(Buffer.from("image"), "image/png", source, new AbortController().signal);
  expect(result.page.blocks).toEqual([{ kind, text: "First\nSecond", type: kind === "heading" ? "heading" : kind === "list" ? "list_item" : kind === "furniture" ? "other" : "paragraph" }]);
  expect(model.doGenerateCalls).toHaveLength(2);
});

it.each([false, true])("counter-line repair requires the preset opt-in: %s", async (omitVerseCounters) => {
  const source = Array.from({ length: 8 }, (_, i) => ({ id: i, text: i === 0 ? "150 verse" : i === 5 ? "155 missing verse" : "verse", box: [i % 5 === 0 ? 60 : 100, 100 + i * 15, 350, 110 + i * 15] as [number, number, number, number] }));
  const ordered = { groups: [{ section: 0, kind: "verse", breakBefore: "paragraph", lineIds: [0, 1, 2, 3, 4, 6, 7] }] };
  const model = new MockLanguageModelV4({ doGenerate: [response(ordered), response({ blocks: [{ group: 0, type: "verse", text: source.map((l) => l.text).join("\n") }] })] });
  const read = makeOrderedReader(model, { ...STANDARD_EXTRACTION, omitVerseCounters })(Buffer.from("image"), "image/png", source, new AbortController().signal);
  if (omitVerseCounters) {
    const result = await read;
    expect(result.restoredLineIds).toEqual([5]);
    expect(result.page.lineGroups?.flat().map((line) => line.id)).toEqual(source.map((line) => line.id));
    expect(result.page.blocks[0]?.text).toContain("155 missing verse");
  } else {
    await expect(read).rejects.toThrow("omitted lines: 5");
    expect(model.doGenerateCalls).toHaveLength(1);
  }
});
