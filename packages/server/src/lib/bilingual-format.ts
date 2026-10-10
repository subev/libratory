import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const BILINGUAL_FORMAT = "p2af-bilingual/1";
const id = z.string().min(1);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative();
const range = z.tuple([offset, offset]).refine(([start, end]) => end > start, "Empty or reversed range");
const edge = z.discriminatedUnion("method", [
  z.object({ method: z.literal("provider-word"), ms: z.number().nonnegative() }),
  z.object({ method: z.literal("chunk-boundary"), ms: z.number().nonnegative() }),
  z.object({ method: z.literal("interpolated"), ms: z.number().nonnegative() }),
  z.object({ method: z.literal("unavailable"), ms: z.null() }),
]);
const token = z.object({ id: offset, range });
const anchor = z.object({ range, kind: z.enum(["word", "passage"]), start: edge, end: edge });
const narration = z.object({
  revision,
  audio: id,
  totalMs: z.number().positive(),
  // The narrator's label, for a shelf that only imports the file; absent in older documents
  voice: z.string().nullable().optional(),
  anchors: z.array(anchor),
  qualityNotes: z.array(z.string()),
});
const lane = z.object({
  id,
  language: id,
  text: z.string(),
  textRevision: revision,
  tokens: z.array(token),
  narration: narration.nullable(),
});
const pair = z.object({
  id,
  status: z.enum(["matched", "uncertain", "source-only", "target-only"]),
  source: range.nullable(),
  target: range.nullable(),
  linksStatus: z.enum(["ready", "partial", "unavailable"]),
  links: z.array(z.object({ source: z.array(offset).min(1), target: z.array(offset).min(1) })),
});

export const bilingualReferenceSchema = z.object({ key: id, language: id, url: id });
export type BilingualReference = z.infer<typeof bilingualReferenceSchema>;

export function bilingualReferences(value: unknown): BilingualReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const parsed = bilingualReferenceSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const document = z.object({
  format: z.literal(BILINGUAL_FORMAT),
  chapterId: id,
  key: id,
  tokenizer: id,
  source: lane,
  target: lane,
  pairs: z.array(pair),
});

export type BilingualDocument = z.infer<typeof document>;
export type BilingualLane = BilingualDocument["source"];
export type BilingualPair = BilingualDocument["pairs"][number];
export type BilingualToken = BilingualLane["tokens"][number];
export type BilingualAnchor = z.infer<typeof anchor>;
export type BilingualSide = "source" | "target";
export type TextRange = [number, number];

function inside(inner: TextRange, outer: TextRange): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

export function tokensIn(lane: Pick<BilingualLane, "tokens">, range: TextRange | null): BilingualToken[] {
  return range ? lane.tokens.filter((token) => inside(token.range, range)) : [];
}

export function graphemeBoundaries(text: string): Set<number> {
  return new Set([text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (segment) => segment.index)]);
}

export function parseBilingualDocument(value: unknown): BilingualDocument {
  const doc = document.parse(value);
  const require = (valid: boolean, message: string) => { if (!valid) throw new Error(`Invalid bilingual document: ${message}`); };
  require(doc.source.id !== doc.target.id, "lane IDs must differ");
  require(new Set(doc.pairs.map((p) => p.id)).size === doc.pairs.length, "duplicate pair ID");
  for (const side of ["source", "target"] as const) {
    const lane = doc[side];
    const boundaries = graphemeBoundaries(lane.text);
    const validRange = (r: TextRange) => boundaries.has(r[0]) && boundaries.has(r[1]);
    require(new Set(lane.tokens.map((t) => t.id)).size === lane.tokens.length, "duplicate token ID");
    let end = 0;
    for (const token of lane.tokens) {
      require(validRange(token.range) && token.range[0] >= end, "invalid or overlapping token range");
      end = token.range[1];
    }
    for (const anchor of lane.narration?.anchors ?? []) {
      require(validRange(anchor.range), "anchor outside text");
      const start = anchor.start.ms, finish = anchor.end.ms;
      require(start === null || finish === null || start <= finish, "reversed timing");
      require([start, finish].every((ms) => ms === null || ms <= (lane.narration?.totalMs ?? 0)), "timing outside recording");
    }
    end = 0;
    const tokens = new Map(lane.tokens.map((t) => [t.id, t]));
    for (const pair of doc.pairs) {
      const r = pair[side];
      if (r) {
        require(validRange(r) && r[0] >= end, "invalid or overlapping pair range");
        require(lane.text.slice(end, r[0]).trim().length === 0, "unrepresented text between pairs");
        end = r[1];
      }
      for (const link of pair.links) {
        require(new Set(link[side]).size === link[side].length, "duplicate linked token");
        for (const id of link[side]) {
          const token = tokens.get(id);
          require(!!token && !!r && inside(token.range, r), "link references a token outside its pair");
        }
      }
    }
    require(lane.text.slice(end).trim().length === 0, "unrepresented trailing text");
  }
  for (const pair of doc.pairs) {
    switch (pair.status) {
      case "source-only": require(!!pair.source && !pair.target, "status and ranges disagree"); break;
      case "target-only": require(!pair.source && !!pair.target, "status and ranges disagree"); break;
      case "matched":
      case "uncertain": require(!!pair.source && !!pair.target, "status and ranges disagree"); break;
      default: { const unhandled: never = pair.status; throw new Error(`Unknown pair status: ${unhandled}`); }
    }
    require((pair.status === "matched" && pair.linksStatus !== "unavailable") || pair.links.length === 0, "links asserted for an unresolved pair");
  }
  return doc;
}

export function textRevision(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

export function readBilingualDocument(value: unknown): BilingualDocument {
  const doc = parseBilingualDocument(value);
  if (textRevision(doc.source.text) !== doc.source.textRevision || textRevision(doc.target.text) !== doc.target.textRevision) throw new Error("Bilingual text revision does not match its content");
  return doc;
}

// Loaded timing arrays are immutable; replacing a recording supplies a new array and index.
const passageIndexes = new WeakMap<BilingualAnchor[], Map<string, BilingualAnchor>>();

export function passageAnchor(lane: BilingualLane, range: TextRange | null): BilingualAnchor | null {
  const anchors = lane.narration?.anchors;
  if (!range || !anchors) return null;
  let index = passageIndexes.get(anchors);
  if (!index) {
    index = new Map();
    for (const anchor of anchors) {
      const key = anchor.range.join(":");
      if (anchor.kind === "passage" && !index.has(key)) index.set(key, anchor);
    }
    passageIndexes.set(anchors, index);
  }
  return index.get(range.join(":")) ?? null;
}

export function pairAtTime(doc: BilingualDocument, side: BilingualSide, ms: number): BilingualPair | null {
  let preceding: BilingualPair | null = null;
  for (const pair of doc.pairs) {
    const range = pair[side];
    if (!range) continue;
    const anchor = passageAnchor(doc[side], range);
    if (!anchor || anchor.start.ms === null || anchor.end.ms === null) { preceding = null; continue; }
    if (ms < anchor.start.ms) return preceding;
    if (ms < anchor.end.ms) return pair;
    preceding = pair;
  }
  return ms <= (doc[side].narration?.totalMs ?? 0) ? preceding : null;
}

export function tokenAtTime(lane: BilingualLane, ms: number): BilingualToken | null {
  const anchor = lane.narration?.anchors.find((a) => a.kind === "word" && a.start.ms !== null && a.end.ms !== null && a.end.ms > a.start.ms && ms >= a.start.ms && ms < a.end.ms);
  return anchor ? lane.tokens.find((t) => inside(t.range, anchor.range)) ?? null : null;
}

// Only an explicit mapping supplies a counterpart. Never flood-fill through a shared token:
// "goose" and "boy" sharing a translation does not make every adjacent source word equivalent.
export function linkedTokens(pair: BilingualPair, side: BilingualSide, id: number): { source: number[]; target: number[] } {
  const links = pair.status === "matched" ? pair.links.filter((link) => link[side].includes(id)) : [];
  return { source: [...new Set(links.flatMap((l) => l.source))], target: [...new Set(links.flatMap((l) => l.target))] };
}

export function switchNarration(doc: BilingualDocument, side: BilingualSide, ms: number): { side: BilingualSide; ms: number } | null {
  const target = side === "source" ? "target" : "source";
  const pair = pairAtTime(doc, side, ms) ?? (ms === 0 ? doc.pairs[0] : null);
  if (pair?.status !== "matched") return null;
  const at = passageAnchor(doc[target], pair[target])?.start.ms;
  return at === undefined || at === null ? null : { side: target, ms: at };
}
