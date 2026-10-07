import { matchesTexts, type BilingualJob, type LinkArtifact, type PairArtifact } from "./bilingual-preparation.ts";
import type { ChapterVariant } from "../schema.ts";

// Where one chapter stands on the way to two-language reading, in the order the steps happen. The
// chapter table, the tray and the preparation dialog all read this, so they cannot disagree.
export type BilingualStep =
  | "no-translation"      // no translation into this language
  | "translating"         // queued or running now
  | "translation-stopped" // stopped before it finished — a cancel, or a run that never got to it
  | "translation-failed"
  | "no-text"        // finished, but one side has no text to pair
  | "pairing"
  | "pair-failed"
  | "unpaired"
  | "outdated"       // paired once, but a text has changed since
  | "linking"
  | "paired"         // sentences paired; some words not linked yet
  | "linked";

export type BilingualChapterState = {
  step: BilingualStep;
  /** Sentence groups, how many matched across the languages, and how many of those have word links. */
  pairs: number;
  matched: number;
  linked: number;
  progress: { done: number; total: number } | null;
  /** The last failed run's message, when the step it belongs to is still unfinished. */
  error: string | null;
};

const busy = (job: BilingualJob | null | undefined) => job?.status === "queued" || job?.status === "running";

export function bilingualChapterState(input: {
  variant: { kind: string; status: ChapterVariant["status"] } | null;
  source: string;
  target: string;
  row: { pairs: PairArtifact | null; links: LinkArtifact | null; pairJob: BilingualJob | null; linkJob: BilingualJob | null } | null;
}): BilingualChapterState {
  const none = { pairs: 0, matched: 0, linked: 0, progress: null, error: null };
  const { variant, row } = input;
  if (!variant || variant.kind !== "translation") return { ...none, step: "no-translation" };
  // Every unfinished status is its own step: a stopped translation once read "Translating" here
  switch (variant.status) {
    case "done": break;
    case "pending":
    case "translating": return { ...none, step: "translating" };
    case "suspended": return { ...none, step: "translation-stopped" };
    case "failed": return { ...none, step: "translation-failed" };
    default: {
      const unhandled: never = variant.status;
      throw new Error(`unhandled translation status ${unhandled}`);
    }
  }
  if (!input.source || !input.target) return { ...none, step: "no-text" };
  if (busy(row?.pairJob)) return { ...none, step: "pairing", progress: progressOf(row?.pairJob) };

  const artifact = row?.pairs ?? null;
  if (!artifact || !matchesTexts(artifact, input.source, input.target)) {
    if (row?.pairJob?.status === "failed") return { ...none, step: "pair-failed", error: row.pairJob.error };
    return { ...none, step: artifact ? "outdated" : "unpaired" };
  }
  const counts = {
    ...none,
    pairs: artifact.pairs.length,
    matched: artifact.pairs.filter((pair) => pair.status === "matched").length,
    linked: row?.links?.pairRevision === artifact.revision ? Object.keys(row.links.byPair).length : 0,
  };
  if (busy(row?.linkJob)) return { ...counts, step: "linking", progress: progressOf(row?.linkJob) };
  const done = counts.matched > 0 && counts.linked >= counts.matched;
  return { ...counts, step: done ? "linked" : "paired", error: !done && row?.linkJob?.status === "failed" ? row.linkJob.error : null };
}

function progressOf(job: BilingualJob | null | undefined) {
  return job && job.total > 0 ? { done: job.done, total: job.total } : null;
}
