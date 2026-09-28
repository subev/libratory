// Approach A, kept for comparison: translate with ⟦n⟧ markers so pairs come out of the translation
// itself. Measured +12–19% output tokens over the plain prompt; B (align.mts) needs no model at all.
import { generateText } from "ai";
import { resolveLlm } from "../../src/lib/llm.ts";
import type { Span } from "./segment.mts";

const system = (language: string, tail: string) => [
  `You are a professional literary translator. Translate the user's text into ${language} for a reader who will read the original and your translation side by side, one sentence against the other.`,
  "The input is sentences, each introduced by a marker ⟦n⟧. Write the translation as natural prose and put a marker in front of the text that translates each source sentence: ⟦n⟧.",
  "If one translated sentence covers several consecutive source sentences, write a single range marker ⟦n-m⟧. If one source sentence needs several translated sentences, they all follow its one marker.",
  "Every source number must be covered exactly once and in order. Keep blank lines between paragraphs where the source has them.",
  "Stay close to the sentence boundaries of the original whenever the target language allows it — never at the cost of natural, idiomatic text. Preserve style, tone and names.",
  tail ? `You are continuing a translation in progress. Its tail so far:\n\n${tail}` : "",
  "Output ONLY the marked translation.",
].filter(Boolean).join("\n\n");

export type Group = { from: number; to: number; text: string };
export type PairedRun = { groups: Group[]; blocks: number; validFirstTry: number; problems: string[]; tokensIn: number; tokensOut: number };

export async function pairedTranslation(src: Span[], srcText: string, language: string): Promise<PairedRun> {
  const { model } = await resolveLlm();
  const run: PairedRun = { groups: [], blocks: 0, validFirstTry: 0, problems: [], tokensIn: 0, tokensOut: 0 };
  let tail = "";
  for (const [a, b] of blocks(src)) {
    run.blocks++;
    const input = src.slice(a, b + 1).map((s, k) => {
      const gap = k > 0 && /\n\s*\n/.test(srcText.slice(src[a + k - 1]!.end, s.start)) ? "\n\n" : " ";
      return `${k ? gap : ""}⟦${a + k + 1}⟧ ${srcText.slice(s.start, s.end)}`;
    }).join("");
    let parsed: ReturnType<typeof parse> | null = null;
    for (let attempt = 0; attempt < 2 && !parsed?.ok; attempt++) {
      const r = await generateText({ model, system: system(language, tail), prompt: input, temperature: 1.3, providerOptions: { deepseek: { thinking: { type: "disabled" } } } });
      run.tokensIn += r.usage.inputTokens ?? 0;
      run.tokensOut += r.usage.outputTokens ?? 0;
      parsed = parse(r.text, a + 1, b + 1);
      if (attempt === 0 && parsed.ok) run.validFirstTry++;
      if (!parsed.ok) run.problems.push(`block ${run.blocks}: ${parsed.problems.join("; ")}`);
    }
    run.groups.push(...(parsed?.groups ?? []));
    tail = (parsed?.groups ?? []).map((g) => g.text).join(" ").slice(-800);
  }
  return run;
}

function blocks(src: Span[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0, size = 0;
  src.forEach((s, i) => {
    if (size && size + (s.end - s.start) > 2500) { out.push([start, i - 1]); start = i; size = 0; }
    size += s.end - s.start;
  });
  out.push([start, src.length - 1]);
  return out;
}

function parse(out: string, first: number, last: number) {
  const hits = [...out.matchAll(/⟦\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*⟧/g)];
  const groups: Group[] = [];
  const problems: string[] = [];
  let expect = first;
  hits.forEach((h, k) => {
    const from = Number(h[1]), to = h[2] ? Number(h[2]) : from;
    const text = out.slice((h.index ?? 0) + h[0].length, hits[k + 1]?.index ?? out.length).trim();
    if (from !== expect) problems.push(`expected ⟦${expect}⟧, got ⟦${from}⟧`);
    if (!text) problems.push(`empty ⟦${from}⟧`);
    groups.push({ from, to, text });
    expect = Math.max(expect, to + 1);
  });
  if (expect !== last + 1) problems.push(`coverage ends at ${expect - 1}, want ${last}`);
  return { ok: problems.length === 0, groups, problems };
}
