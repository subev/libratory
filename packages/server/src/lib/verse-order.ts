import type { TextKind } from "./extracted-text.ts";
import type { OcrLine } from "./ocr-line-order.ts";

type Group = { kind: TextKind; lineIds: number[] };

function counter(line: OcrLine): number | null {
  const match = /^\s*(\d+)\s+\S/u.exec(line.text);
  const value = match ? Number(match[1]) : 0;
  return value > 0 && value % 5 === 0 ? value : null;
}

export function restoreInteriorCounterLines<T extends Group>(lines: OcrLine[], groups: T[]): { groups: T[]; restored: number[] } {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const seen = new Set(groups.flatMap((group) => group.lineIds));
  const result = groups.map((group) => ({ ...group, lineIds: [...group.lineIds] }));
  const restored: number[] = [];
  for (const line of lines) {
    const value = counter(line);
    if (seen.has(line.id) || value === null) continue;
    const candidates: { group: T; index: number }[] = [];
    for (const group of result) {
      if (group.kind !== "verse") continue;
      for (let index = 1; index < group.lineIds.length; index++) {
        const aId = group.lineIds[index - 1];
        const bId = group.lineIds[index];
        const a = aId === undefined ? undefined : byId.get(aId);
        const b = bId === undefined ? undefined : byId.get(bId);
        if (!a || !b || a.box[3] > line.box[1] || line.box[3] > b.box[1]) continue;
        const boxes = [a.box, line.box, b.box];
        const width = Math.min(...boxes.map((box) => box[2] - box[0]));
        const overlap = Math.min(...boxes.map((box) => box[2])) - Math.max(...boxes.map((box) => box[0]));
        const height = Math.max(...boxes.map((box) => box[3] - box[1]));
        if (width <= 0 || overlap < width * 0.8 || b.box[1] - a.box[3] > height * 3) continue;
        if (line.box[0] > Math.min(a.box[0], b.box[0]) - 5) continue;
        const ids = [...group.lineIds.slice(0, index), line.id, ...group.lineIds.slice(index)];
        // The missing counter must agree with another printed counter at its exact verse distance.
        const anchored = ids.some((id, position) => {
          const anchor = byId.get(id);
          const number = anchor && id !== line.id ? counter(anchor) : null;
          return number !== null && value - number === index - position;
        });
        if (anchored) candidates.push({ group, index });
      }
    }
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (!candidate) continue;
    candidate.group.lineIds.splice(candidate.index, 0, line.id);
    seen.add(line.id);
    restored.push(line.id);
  }
  return { groups: result, restored };
}
