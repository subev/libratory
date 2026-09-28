import { passageAnchor, type BilingualDocument, type BilingualLane, type BilingualPair, type BilingualSide, type BilingualToken } from "../../../server/src/lib/bilingual-format.ts";

export function paragraphGroups(doc: BilingualDocument): BilingualPair[][] {
  const groups: BilingualPair[][] = [];
  let previousSource = 0, previousTarget = 0;
  for (const pair of doc.pairs) {
    const sourceGap = pair.source ? doc.source.text.slice(previousSource, pair.source[0]) : "";
    const targetGap = pair.target ? doc.target.text.slice(previousTarget, pair.target[0]) : "";
    const paragraphBreak = /\n\s*\n/.test(sourceGap) || /\n\s*\n/.test(targetGap);
    const last = groups[groups.length - 1];
    if (!last || paragraphBreak) groups.push([pair]);
    else last.push(pair);
    if (pair.source) previousSource = pair.source[1];
    if (pair.target) previousTarget = pair.target[1];
  }
  return groups;
}

export function listenPosition(lane: BilingualLane, pair: BilingualPair, side: "source" | "target", tokenId: number) {
  const token = lane.tokens.find((t) => t.id === tokenId);
  const word = token ? lane.narration?.anchors.find((a) => a.kind === "word" && a.range[0] <= token.range[0] && a.range[1] >= token.range[1] && a.start.ms !== null && a.end.ms !== null && a.end.ms > a.start.ms) : undefined;
  const anchor = word ?? passageAnchor(lane, pair[side]);
  return anchor?.start.ms === null || anchor?.start.ms === undefined ? null : { ms: anchor.start.ms, word: !!word };
}

export function linkedText(lane: BilingualLane, ids: number[]): string {
  const selected = new Set(ids);
  let previous = -2;
  return lane.tokens.flatMap((token, index) => {
    if (!selected.has(token.id)) return [];
    const preceding = lane.tokens[previous];
    const separator = previous < 0 ? "" : index === previous + 1 && preceding ? lane.text.slice(preceding.range[1], token.range[0]).replace(/\s+/g, " ") : " … ";
    previous = index;
    return [separator + lane.text.slice(...token.range)];
  }).join("");
}

export function pairPresentation(doc: BilingualDocument, side: BilingualSide) {
  const lane = doc[side];
  const result = new Map<string, { tokens: { token: BilingualToken; before: string; text: string }[]; after: string }>();
  let tokenIndex = 0;
  const pairs = doc.pairs.filter((pair) => pair[side]);
  for (const [index, pair] of pairs.entries()) {
    const range = pair[side];
    if (!range) continue;
    const tokens = [];
    let cursor = range[0];
    while (tokenIndex < lane.tokens.length) {
      const token = lane.tokens[tokenIndex];
      if (!token || token.range[0] >= range[1]) break;
      tokenIndex++;
      if (token.range[0] < range[0] || token.range[1] > range[1]) continue;
      const limit = Math.min(range[1], lane.tokens[tokenIndex]?.range[0] ?? range[1]);
      const punctuation = lane.text.slice(token.range[1], limit).match(/^[\p{P}\p{S}]+/u)?.[0] ?? "";
      const end = token.range[1] + punctuation.length;
      tokens.push({ token, before: lane.text.slice(cursor, token.range[0]), text: lane.text.slice(token.range[0], end) });
      cursor = end;
    }
    const next = pairs[index + 1]?.[side];
    result.set(pair.id, { tokens, after: lane.text.slice(cursor, next?.[0] ?? range[1]) });
  }
  return result;
}

export function sharesPrimaryRecording(doc: BilingualDocument, audio: string | null): boolean {
  return audio !== null && doc.source.narration?.audio === audio;
}

export type SentencePlayback = { side: BilingualSide; pairId: string; startMs: number; endMs: number };

export function sentenceSequence(doc: BilingualDocument, first: BilingualSide): (SentencePlayback | null)[] {
  const other = first === "source" ? "target" : "source";
  return doc.pairs.flatMap((pair) => {
    const clips = ([first, other] as const).map((side): SentencePlayback | null => {
      const anchor = passageAnchor(doc[side], pair[side]);
      if (pair.status !== "matched" || !anchor || anchor.start.ms === null || anchor.end.ms === null || anchor.end.ms <= anchor.start.ms) return null;
      return { side, pairId: pair.id, startMs: anchor.start.ms, endMs: anchor.end.ms };
    });
    return clips.every((clip) => clip !== null) ? clips : [null, null];
  });
}

export function sentenceStartIndex(doc: BilingualDocument, side: BilingualSide, ms: number): number {
  const index = doc.pairs.findIndex((pair) => {
    const anchor = passageAnchor(doc[side], pair[side]);
    return anchor?.start.ms !== null && anchor?.start.ms !== undefined && anchor.end.ms !== null && ms < anchor.end.ms;
  });
  return index < 0 ? -1 : index * 2;
}
