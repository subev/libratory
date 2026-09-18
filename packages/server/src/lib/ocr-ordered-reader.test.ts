import { beforeEach, expect, it, vi } from "vitest";
import { makeOrderedReader, OrderedReadError } from "./ocr-line-order.ts";
import { STANDARD_EXTRACTION } from "./extraction-presets.ts";
import { orderingCheckpoint, stageCheckpoint } from "./ocr-stage-cache.ts";
import type { LlmModelDef } from "./llm.ts";
import { createRepairBudget } from "./ocr-repair.ts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: model.call }));
beforeEach(() => model.call.mockReset());
const image = Buffer.from("page");
const signal = new AbortController().signal;

it("locally recovers both stages from a compatible legacy response without any AI call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "local-page-recovery-"));
  try {
    const lines = [{ id: 1, text: "Body", box: [100, 100, 900, 120] as [number, number, number, number] }];
    const order = { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [1] }] };
    const response = JSON.stringify({ blocks: [{ group: 0, text: "Body", type: "paragraph" }] });
    await writeFile(path.join(dir, "ocr-failure-page-1-100.json"), JSON.stringify({ stage: "transcription", model: "M", settingsKey: "same", lines, order, response, message: "Older validation rejected this response" }));
    const legacy = { model: "M", settingsKey: "same", lines };
    const recovery = { budget: createRepairBudget(0), log: async () => {},
      transcription: (value: unknown) => stageCheckpoint(dir, 1, "transcription", value, { ...legacy, order: value }),
    };
    const result = await makeOrderedReader("test-model", STANDARD_EXTRACTION)(image, "image/png", lines, signal, undefined,
      orderingCheckpoint(dir, 1, ["legacy"], legacy), recovery);
    expect(result.page.blocks[0]?.text).toBe("Body");
    expect(result.inputTokens).toBe(0);
    expect(model.call).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("repairs only a rejected transcription and reuses both stages on a later run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "targeted-transcription-"));
  try {
    const lines = [{ id: 22, text: "Retain this line", box: [100, 100, 900, 120] as [number, number, number, number] }];
    const order = { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [22] }] };
    model.call.mockResolvedValueOnce({ output: order, usage: { inputTokens: 2 } });
    model.call.mockResolvedValueOnce({ output: { blocks: [] }, usage: { inputTokens: 3 } });
    model.call.mockResolvedValueOnce({ output: { blocks: [{ group: 0, text: "Retain this line", type: "paragraph" }] }, usage: { inputTokens: 5 } });
    const checkpoint = orderingCheckpoint(dir, 1, ["order"]);
    const recovery = { budget: createRepairBudget(1), log: async () => {}, transcription: (value: unknown) => stageCheckpoint(dir, 1, "transcription", ["transcription", value]) };
    const read = makeOrderedReader("test-model", STANDARD_EXTRACTION);
    expect(await read(image, "image/png", lines, signal, undefined, checkpoint, recovery)).toMatchObject({ inputTokens: 10, page: { blocks: [{ text: "Retain this line" }] } });
    expect(model.call).toHaveBeenCalledTimes(3);
    expect(model.call.mock.calls[2]?.[0].messages[0].content[0].text).toContain("Transcription omitted or reordered");
    expect(model.call.mock.calls[2]?.[0].messages[0].content[0].text).toContain('"blocks":[]');
    expect(recovery.budget.used).toBe(1);
    model.call.mockReset();
    await read(image, "image/png", lines, signal, undefined, checkpoint, recovery);
    expect(model.call).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("repairs a legacy rejected ordering with its omitted line IDs and preserves its response", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "targeted-ordering-"));
  try {
    const lines = [{ id: 22, text: "Retain this line", box: [100, 100, 900, 120] as [number, number, number, number] }];
    const filename = path.join(dir, "ocr-failure-page-1-100.json");
    const original = JSON.stringify({ stage: "ordering", model: "M", settingsKey: "same", lines, order: { groups: [] }, response: '{"groups":[]}', message: "Missing line 22" });
    await writeFile(filename, original);
    const checkpoint = orderingCheckpoint(dir, 1, ["legacy"], { model: "M", settingsKey: "same", lines });
    model.call.mockResolvedValueOnce({ output: { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [22] }] }, usage: {} });
    model.call.mockResolvedValueOnce({ output: { blocks: [{ group: 0, text: "Retain this line", type: "paragraph" }] }, usage: {} });
    const recovery = { budget: createRepairBudget(1), log: async () => {}, transcription: (value: unknown) => stageCheckpoint(dir, 1, "transcription", value) };
    const def: LlmModelDef = { key: "flash", label: "Flash", hint: "", source: "DeepSeek",
      provider: "deepseek", modelId: "deepseek-flash", contextTokens: 1000000,
      supportsTemperature: true, supportsTools: true, supportsJsonFormat: true };
    const result = await makeOrderedReader("test-model", STANDARD_EXTRACTION, def)(image, "image/png", lines, signal, undefined, checkpoint, recovery);
    expect(model.call.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: 16384, providerOptions: { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" } } });
    expect(model.call.mock.calls[1]?.[0]).toMatchObject({ providerOptions: { deepseek: { thinking: { type: "disabled" } } } });
    expect(result.page.lineGroups?.[0]?.[0]?.id).toBe(22);
    expect(model.call).toHaveBeenCalledTimes(2);
    expect(model.call.mock.calls[0]?.[0].messages[0].content[0].text).toContain("Reading order omitted lines: 22");
    expect(await readFile(filename, "utf8")).toBe(original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("does not buy ordering twice when transcription fails after ordering was saved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ordered-recovery-"));
  try {
    const checkpoint = orderingCheckpoint(dir, 1, ["source", "model", "instructions"]);
    const lines = [{ id: 1, text: "Body text", box: [100, 100, 900, 120] as [number, number, number, number] }];
    model.call.mockResolvedValueOnce({ output: { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [1] }] }, usage: { inputTokens: 20 } });
    model.call.mockRejectedValueOnce(new Error("Provider unavailable"));
    const read = makeOrderedReader("test-model", STANDARD_EXTRACTION);
    await expect(read(image, "image/png", lines, signal, undefined, checkpoint)).rejects.toThrow("Provider unavailable");
    model.call.mockReset();
    model.call.mockResolvedValueOnce({ output: { blocks: [{ group: 0, text: "Body text", type: "paragraph" }] }, usage: { inputTokens: 5 } });
    expect(await read(image, "image/png", lines, signal, undefined, checkpoint)).toMatchObject({ inputTokens: 5 });
    expect(model.call).toHaveBeenCalledOnce();
    expect(model.call.mock.calls[0]?.[0].system).toContain("exactly 1 blocks");
    expect(await orderingCheckpoint(dir, 1, ["source", "model", "new instructions"]).load()).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("recovers a successful ordering from an older transcription-failure diagnostic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "legacy-ordering-"));
  try {
    const lines = [{ id: 1, text: "Body", box: [100, 100, 900, 120] as [number, number, number, number] }];
    const order = { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [1] }] };
    await writeFile(path.join(dir, "ocr-failure-page-1-100.json"), JSON.stringify({ stage: "transcription", model: "M", settingsKey: "same", lines, order }));
    const checkpoint = orderingCheckpoint(dir, 1, ["source", "new-cache"], { model: "M", settingsKey: "same", lines });
    model.call.mockResolvedValueOnce({ output: { blocks: [{ group: 0, type: "paragraph", text: "Body" }] }, usage: {} });
    await makeOrderedReader("test-model", STANDARD_EXTRACTION)(image, "image/png", lines, signal, undefined, checkpoint);
    expect(model.call).toHaveBeenCalledOnce();
    expect(await orderingCheckpoint(dir, 1, ["source", "another-cache"], { model: "M", settingsKey: "changed", lines }).load()).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

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
  model.call.mockResolvedValueOnce({ output: { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [1] }, { section: 0, kind: "footnote", breakBefore: "paragraph", lineIds: [2] }] }, usage: {} });
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

it("splits separate footer items without moving or dropping line IDs", async () => {
  const lines = [
    { id: 1, text: "Verse", box: [100, 100, 300, 120] as [number, number, number, number] },
    { id: 2, text: "Printer signature", box: [50, 940, 450, 960] as [number, number, number, number] },
    { id: 3, text: "11", box: [900, 940, 940, 960] as [number, number, number, number] },
  ];
  model.call.mockResolvedValueOnce({ output: { groups: [
    { section: 0, kind: "verse", breakBefore: "line", lineIds: [1] },
    { section: 0, kind: "furniture", breakBefore: "paragraph", lineIds: [2, 3] },
  ] }, usage: {} });
  model.call.mockResolvedValueOnce({ output: { blocks: lines.map((line, group) => ({ group, type: "other", text: line.text })) }, usage: {} });
  const result = await makeOrderedReader("test-model", STANDARD_EXTRACTION)(image, "image/png", lines, signal);
  expect(result.page.lineGroups?.map((g) => g.map((l) => l.id))).toEqual([[1], [2], [3]]);
  expect(result.page.blocks.map((b) => b.kind)).toEqual(["verse", "furniture", "furniture"]);
  expect(result.page.blocks[0]?.breakBefore).toBeUndefined();
  expect(model.call.mock.calls[1]?.[0].system).toContain("exactly 3 blocks");
});

it("retains the failed ordering response and stops before transcription for mixed body columns", async () => {
  const lines = [
    { id: 1, text: "Left", box: [50, 100, 150, 120] as [number, number, number, number] },
    { id: 2, text: "Right", box: [600, 100, 700, 120] as [number, number, number, number] },
  ];
  const output = { groups: [{ section: 0, kind: "prose", breakBefore: "paragraph", lineIds: [1, 2] }] };
  model.call.mockResolvedValueOnce({ output, text: JSON.stringify(output), usage: {} });
  const result = makeOrderedReader("test-model", STANDARD_EXTRACTION)(image, "image/png", lines, signal);
  await expect(result).rejects.toMatchObject({ diagnostic: { stage: "ordering", lines, order: output, response: JSON.stringify(output) } });
  await expect(result).rejects.toBeInstanceOf(OrderedReadError);
  await expect(result).rejects.toThrow("group 0: lines 1 and 2");
  expect(model.call).toHaveBeenCalledOnce();
});
