export type AiPresetSubject = "chapter" | "chapters" | "book";

export type AiPreset = {
  key: string;
  label: string;
  prompt: (subject: AiPresetSubject) => string;
};

const subjectPhrase: Record<AiPresetSubject, string> = {
  chapter: "this chapter",
  chapters: "these chapters",
  book: "this book",
};

// The Summarize default mirrors Brave Leo's page-summary prompt
export const AI_PRESETS: [AiPreset, ...AiPreset[]] = [
  {
    key: "summarize",
    label: "Summarize",
    prompt: (s) =>
      `Provide a concise list of up to 6 bullets on the most important points of ${subjectPhrase[s]}, followed by a one-paragraph summary.`,
  },
  {
    key: "questions",
    label: "Suggest questions",
    prompt: (s) =>
      `List 8 insightful questions a curious reader could ask about ${subjectPhrase[s]}. Only list the questions — I will pick one to ask next.`,
  },
  {
    key: "explain",
    label: "Explain simply",
    prompt: (s) => `Explain the main ideas and argument of ${subjectPhrase[s]} in plain, simple language.`,
  },
  {
    key: "entities",
    label: "People & terms",
    prompt: (s) =>
      `List the key people, places, and terms mentioned in ${subjectPhrase[s]}, each with a one-line description of who or what they are.`,
  },
  {
    key: "didyouknow",
    label: "Did you know?",
    prompt: (s) =>
      `List the most surprising and essential takeaways from ${subjectPhrase[s]} — the specific facts, claims, and ideas someone would only know after actually reading it. Skip anything guessable from the title alone. Start each item with a short curiosity hook (vary the phrasing, e.g. "Did you know that ...", "Few people realize ...") followed by a couple of sentences of substance.`,
  },
];

// Digest chapters are read aloud — flowing prose, never lists
export const DIGEST_LISTENING_PROMPT =
  "Narrate a spoken summary of this book, about 5 minutes of listening (roughly 600-1200 words). " +
  "Write flowing prose paragraphs in an engaging, radio-essay style — no bullet points, no headings, no markdown. " +
  "Cover the book's core ideas, how it is structured, and its most striking details or arguments. " +
  "Write in the same language as the book's text. Start directly with the content — no preamble about being a summary.";

export const DIGEST_DID_YOU_KNOW_PROMPT =
  "Narrate the most surprising and essential takeaways from this book — the things that make it unique and that you would only know if you had actually read it — about 5 minutes of listening (roughly 600-1200 words). " +
  "Open with a strong \"Did you know that ...\" hook, then keep a curiosity-driven cadence: concrete facts, striking claims, unexpected arguments, memorable examples. Vary the phrasing of the hooks so it never sounds like a repeated formula, and skip anything a listener could guess from the title alone. " +
  "Write flowing prose paragraphs in an engaging, spoken style — no bullet points, no headings, no markdown. " +
  "Write in the same language as the book's text. Start directly with the content — no preamble.";

export const DIGEST_PRESETS = [
  { key: "essay", label: "Radio essay", prompt: DIGEST_LISTENING_PROMPT },
  { key: "didyouknow", label: "Did you know?", prompt: DIGEST_DID_YOU_KNOW_PROMPT },
] as const;

// No DeepSeek tokenizer here — deliberately pessimistic BPE rule of thumb
// (~3.4 chars/token for ASCII, ~1.4 for non-Latin scripts) so estimates overestimate.
export function estimateTokensFromCounts(ascii: number, nonAscii: number): number {
  return Math.round(ascii / 3.4 + nonAscii / 1.4);
}

export function estimateTokens(text: string): number {
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  return estimateTokensFromCounts(text.length - nonAscii, nonAscii);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
}
