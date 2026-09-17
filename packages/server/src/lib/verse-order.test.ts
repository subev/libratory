import { expect, it } from "vitest";
import { restoreInteriorCounterLines } from "./verse-order.ts";
import { validateLineOrder, type OcrLine } from "./ocr-line-order.ts";
import type { TextKind } from "./extracted-text.ts";

const lines: OcrLine[] = Array.from({ length: 8 }, (_, i) => ({ id: i, text: i === 0 ? "150 verse" : i === 5 ? "155 missing verse" : "verse", box: [i % 5 === 0 ? 60 : 100, 100 + i * 15, 350, 110 + i * 15] }));
const groups = [{ kind: "verse" as const, lineIds: [0, 1, 2, 3, 4, 6, 7] }];

it("restores a counter-bearing verse line only where geometry and exact counter spacing agree", () => {
  const result = restoreInteriorCounterLines(lines, groups);
  expect(result.restored).toEqual([5]);
  expect(validateLineOrder(lines, result.groups.map((g) => g.lineIds))[0]?.map((l) => l.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(groups[0]?.lineIds).not.toContain(5);
});

it.each(["unnumbered", "wrong counter", "no anchor", "inline number", "other column", "prose", "ambiguous"])("leaves %s omissions rejected", (scenario) => {
  const input = lines.map((l) => ({ ...l, box: [...l.box] as OcrLine["box"] }));
  const missing = input[5];
  const anchor = input[0];
  if (!missing || !anchor) throw new Error("Missing fixture");
  if (scenario === "unnumbered") missing.text = "missing verse";
  if (scenario === "wrong counter") missing.text = "160 missing verse";
  if (scenario === "no anchor") anchor.text = "verse";
  if (scenario === "inline number") missing.box[0] = 100;
  if (scenario === "other column") missing.box = [600, 175, 900, 185];
  const inputGroups: { kind: TextKind; lineIds: number[] }[] = scenario === "prose" ? [{ kind: "prose", lineIds: groups[0]?.lineIds ?? [] }] : scenario === "ambiguous" ? [...groups, ...groups] : groups;
  const result = restoreInteriorCounterLines(input, inputGroups);
  expect(result.restored).toEqual([]);
  expect(() => validateLineOrder(input, result.groups.map((g) => g.lineIds))).toThrow();
});
