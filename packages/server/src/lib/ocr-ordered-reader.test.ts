import { beforeEach, expect, it, vi } from "vitest";
import { makeOrderedReader } from "./ocr-line-order.ts";
import { STANDARD_EXTRACTION } from "./extraction-presets.ts";
const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: model.call }));
beforeEach(() => model.call.mockReset());
const image = Buffer.from("page");
const signal = new AbortController().signal;

it("checks an undetected page with the model before accepting it as blank", async () => {
  model.call.mockResolvedValueOnce({ output: { hasText: false }, usage: { inputTokens: 10, outputTokens: 2 } });
  const read = makeOrderedReader("test-model", STANDARD_EXTRACTION);
  expect(await read(image, "image/png", [], signal)).toMatchObject({ page: { blocks: [], lineGroups: [] }, inputTokens: 10 });
  expect(model.call).toHaveBeenCalledOnce();
  expect(model.call.mock.calls[0]?.[0]).toMatchObject({ maxRetries: 0 });
  model.call.mockResolvedValueOnce({ output: { hasText: true }, usage: {} });
  await expect(read(image, "image/png", [], signal)).rejects.toThrow("page with text");
});

it("passes the editable prompt and keeps a prose group and its note without an automatic retry", async () => {
  const lines = [
    { id: 1, text: "The prose.", box: [10, 10, 100, 30] as [number, number, number, number] },
    { id: 2, text: "A footnote.", box: [10, 800, 100, 820] as [number, number, number, number] },
  ];
  model.call.mockResolvedValueOnce({ output: { groups: [{ section: 0, kind: "prose", lineIds: [1] }, { section: 0, kind: "footnote", lineIds: [2] }] }, usage: {} });
  model.call.mockResolvedValueOnce({ output: { blocks: [
    { group: 0, type: "paragraph", text: "The prose.", level: null },
    { group: 1, type: "other", text: "A footnote.", level: null },
  ] }, usage: {} });
  const read = makeOrderedReader("test-model", { ...STANDARD_EXTRACTION, prompt: "Keep the author’s words.", lineOrdering: true, omitVerseCounters: true });
  expect((await read(image, "image/png", lines, signal)).page.blocks.map((block) => block.text)).toEqual(["The prose.", "A footnote."]);
  expect(model.call.mock.calls[1]?.[0].system).toContain("Keep the author’s words.");
  expect(model.call.mock.calls[0]?.[0].system).toContain('"lineIds"');
  expect(model.call.mock.calls[1]?.[0].system).toContain('"group"');
  expect(model.call.mock.calls[1]?.[0].messages[0].content[0].text).toContain("Rough OCR labels");
  expect(model.call.mock.calls[1]?.[0].system).toContain("exactly 2 blocks");
  expect(model.call.mock.calls[1]?.[0].system).toContain("retain all printed verse counters");
  expect(model.call.mock.calls.every(([request]) => request.maxRetries === 0)).toBe(true);
});

it.each(["line", "stanza"] as const)("preserves an explicit %s boundary between verse columns", async (breakBefore) => {
  const lines = [
    { id: 1, text: "Left", box: [10, 100, 100, 120] as [number, number, number, number] },
    { id: 2, text: "Right", box: [600, 100, 700, 120] as [number, number, number, number] },
  ];
  model.call.mockResolvedValueOnce({ output: { groups: [
    { section: 0, kind: "verse", breakBefore: "paragraph", lineIds: [1] },
    { section: 0, kind: "verse", breakBefore, lineIds: [2] },
  ] }, usage: {} });
  model.call.mockResolvedValueOnce({ output: { blocks: [
    { group: 0, type: "other", text: "Left" }, { group: 1, type: "other", text: "Right" },
  ] }, usage: {} });
  const result = await makeOrderedReader("test-model", STANDARD_EXTRACTION)(image, "image/png", lines, signal);
  const { pagesToRawText } = await import("./ocr-llm.ts");
  expect(pagesToRawText([result.page])).toBe(breakBefore === "line" ? "Left\nRight" : "Left\n\nRight");
});
