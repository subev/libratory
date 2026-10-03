import { textRevision, type BilingualDocument, type BilingualPair } from "./bilingual-format.ts";

export const PAIRING_VERSION = "bge-m3-dp/1";
export const TOKENIZER_VERSION = "intl-segmenter-word/1";
export const LINK_PROMPT_VERSION = "token-ids/1";

export type PairArtifact = {
  revision: string;
  aligner: string;
  tokenizer: string;
  source: Omit<BilingualDocument["source"], "narration">;
  target: Omit<BilingualDocument["target"], "narration">;
  pairs: BilingualPair[];
};
export type LinkArtifact = {
  pairRevision: string;
  promptVersion: string;
  byPair: Record<string, BilingualPair["links"]>;
  batches: { pairIds: string[]; model: string; raw: string; error: string | null; inputTokens: number; outputTokens: number }[];
};
export type BilingualJob = {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  runId: string;
  model: string | null;
  done: number;
  total: number;
  error: string | null;
  updatedAt: string;
};

export function matchesTexts(artifact: PairArtifact | null, source: string, target: string): boolean {
  return artifact !== null && artifact.source.textRevision === textRevision(source) && artifact.target.textRevision === textRevision(target);
}

export function preparedPairs(artifact: PairArtifact, links: LinkArtifact | null): BilingualPair[] {
  const byPair = links?.pairRevision === artifact.revision ? links.byPair : {};
  return artifact.pairs.map((pair) => ({ ...pair,
    linksStatus: Object.hasOwn(byPair, pair.id) ? "ready" : "unavailable",
    links: byPair[pair.id] ?? [],
  }));
}
