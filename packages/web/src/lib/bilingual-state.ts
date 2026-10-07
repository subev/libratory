import type { BilingualChapterState, BilingualStep } from "../../../server/src/lib/bilingual-chapter-state.ts";

export type { BilingualChapterState, BilingualStep };

export type BilingualTone = "faint" | "muted" | "busy" | "warning" | "danger" | "partial" | "done";

// The table cell: a word or two. The sentence from describeBilingual sits under it as its title.
export function bilingualShort(state: BilingualChapterState): { label: string; tone: BilingualTone } {
  const progress = state.progress ? ` ${state.progress.done}/${state.progress.total}` : "…";
  switch (state.step) {
    case "no-translation": return { label: "No translation", tone: "faint" };
    case "translating": return { label: "Translating", tone: "busy" };
    case "translation-stopped": return { label: "Translation stopped", tone: "faint" };
    case "translation-failed": return { label: "Translation failed", tone: "danger" };
    case "no-text": return { label: "No text", tone: "faint" };
    case "pairing": return { label: `Pairing${progress}`, tone: "busy" };
    case "pair-failed": return { label: "Pairing failed", tone: "danger" };
    case "unpaired": return { label: "Not paired", tone: "muted" };
    case "outdated": return { label: "Text changed", tone: "warning" };
    case "linking": return { label: `Linking${progress}`, tone: "busy" };
    case "paired": return state.error ? { label: "Linking failed", tone: "danger" } : { label: "Paired", tone: "partial" };
    case "linked": return { label: "Words linked", tone: "done" };
    default: {
      const unhandled: never = state.step;
      throw new Error(`unhandled bilingual step ${unhandled}`);
    }
  }
}

// What the state means in a sentence — `language` is the translation it is paired with
export function describeBilingual(state: BilingualChapterState, language: string): string {
  // A group with no partner (a sentence the translation dropped or added) is counted apart, so
  // "words linked in all" refers to the number just before it
  const unmatched = state.pairs - state.matched;
  const groups = `${state.matched} sentence pair${state.matched === 1 ? "" : "s"}${unmatched > 0 ? `, ${unmatched} without a match` : ""}`;
  switch (state.step) {
    case "no-translation": return `No ${language} translation yet — translate this chapter first`;
    case "translating": return `Translating into ${language} now`;
    case "translation-stopped": return `The ${language} translation was stopped before this chapter — Translate in the ${language} view resumes it`;
    case "translation-failed": return `The ${language} translation of this chapter failed — open the ${language} view to see why and retry`;
    case "no-text": return "One side has no text to pair";
    case "pairing": return state.progress ? `Pairing sentences — ${state.progress.done} of ${state.progress.total}` : "Pairing sentences — waiting to start";
    case "pair-failed": return `Pairing failed${state.error ? `: ${state.error}` : ""}`;
    case "unpaired": return "Sentences not paired yet";
    case "outdated": return "A text changed after pairing — pair it again";
    case "linking": return `${groups} · linking words — batch ${state.progress?.done ?? 0} of ${state.progress?.total ?? "?"}`;
    case "paired": return `${groups} · words linked in ${state.linked} of them${state.error ? ` · linking failed: ${state.error}` : ""}`;
    case "linked": return `${groups} · words linked in all of them`;
    default: {
      const unhandled: never = state.step;
      throw new Error(`unhandled bilingual step ${unhandled}`);
    }
  }
}

export const TONE_CLASS: Record<BilingualTone, string> = {
  faint: "text-(--text-faint)",
  muted: "text-(--text-muted)",
  busy: "text-(--accent-text)",
  warning: "text-(--warning-text)",
  danger: "text-(--danger-text)",
  partial: "text-(--text-secondary)",
  done: "text-(--success-text)",
};

/** Readable in the bilingual reader: sentences paired, whether or not words are linked yet. */
export const isReadable = (step: BilingualStep) => step === "paired" || step === "linking" || step === "linked";
/** Pairing is the next thing this chapter needs, and nothing stands in its way. */
export const needsPairing = (step: BilingualStep) => step === "unpaired" || step === "outdated" || step === "pair-failed";
/** No translation to pair with: the fix is in the translation, not here. */
export const needsTranslation = (step: BilingualStep) =>
  step === "no-translation" || step === "translating" || step === "translation-stopped" || step === "translation-failed" || step === "no-text";
