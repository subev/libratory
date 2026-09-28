// What both link prompts share: the pairs they are asked about, the batches, the result shape, and
// the rules a batch's answer is checked against. A failed or incomplete batch is recorded and left
// for the user to re-run; nothing is retried here.
import { generateText } from "ai";
import { resolveLlm } from "../../src/lib/llm.ts";
import type { Span } from "./segment.mts";
import type { Token } from "./tokens.mts";

export type LinkPair = { id: string; s: Span; t: Span; sTokens: Token[]; tTokens: Token[] };
// A relation between token groups; either side may be several tokens, adjacent or not
export type Link = { pairId: string; s: number[]; t: number[] };
export type BatchRecord = { pairIds: string[]; finishReason: string; error?: string; raw: string;
  system?: string; prompt?: string; responseModel?: string; reasoningTokens?: number; ms?: number };
export type LinkRun = {
  method: string;
  links: Link[];
  answered: string[]; // pairs the answer mentioned, even with an explicit "no links"
  missing: string[]; // requested pairs the answer never mentioned
  invalid: string[]; // lines that named a pair outside the batch, an unknown token, or no text
  batches: BatchRecord[];
  tokensIn: number;
  tokensOut: number;
  ms: number;
};

// Bounded by text size, not pair count: one long pair must not blow a batch's output budget
const BATCH_CHARS = 5000;

export function batches(pairs: LinkPair[], text: (p: LinkPair) => string): LinkPair[][] {
  const out: LinkPair[][] = [];
  let current: LinkPair[] = [], size = 0;
  for (const p of pairs) {
    const n = text(p).length;
    if (current.length && size + n > BATCH_CHARS) { out.push(current); current = []; size = 0; }
    current.push(p);
    size += n;
  }
  if (current.length) out.push(current);
  return out;
}

export type ParsedLine = { pairId: string; link: Link | null } | { invalid: string };
export type LinkOptions = { modelKey?: string; maxOutputTokens?: number; thinking?: boolean; timeoutMs?: number };

export async function runLinks(
  method: string,
  pairs: LinkPair[],
  system: string,
  prompt: (batch: LinkPair[]) => string,
  parse: (line: string, batch: Map<string, LinkPair>) => ParsedLine | null,
  options: LinkOptions = {},
): Promise<LinkRun> {
  const { model } = await resolveLlm(options.modelKey);
  const run: LinkRun = { method, links: [], answered: [], missing: [], invalid: [], batches: [], tokensIn: 0, tokensOut: 0, ms: 0 };
  const t0 = Date.now();

  await Promise.all(batches(pairs, (p) => prompt([p])).map(async (batch) => {
    const byId = new Map(batch.map((p) => [p.id, p]));
    const batchPrompt = prompt(batch);
    const record: BatchRecord = { pairIds: batch.map((p) => p.id), finishReason: "", raw: "", system, prompt: batchPrompt };
    run.batches.push(record);
    const started = Date.now();
    try {
      const answer = await generateText({
        model,
        system,
        prompt: batchPrompt,
        temperature: 0.3,
        maxRetries: 0,
        maxOutputTokens: options.maxOutputTokens ?? 8192,
        providerOptions: { deepseek: { thinking: { type: options.thinking ? "enabled" : "disabled" } } },
        ...(options.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : {}),
      });
      record.finishReason = answer.finishReason;
      record.raw = answer.text;
      record.responseModel = answer.response?.modelId;
      record.reasoningTokens = answer.usage.outputTokenDetails?.reasoningTokens;
      run.tokensIn += answer.usage.inputTokens ?? 0;
      run.tokensOut += answer.usage.outputTokens ?? 0;
      if (answer.finishReason !== "stop") throw new Error(`Incomplete link batch: finish reason ${answer.finishReason}`);
      const answered = new Set<string>();
      for (const line of answer.text.split("\n")) {
        const parsed = parse(line, byId);
        if (!parsed) continue;
        if ("invalid" in parsed) { run.invalid.push(parsed.invalid); continue; }
        answered.add(parsed.pairId);
        if (parsed.link && !run.links.some((l) => sameLink(l, parsed.link!))) run.links.push(parsed.link);
      }
      run.answered.push(...answered);
      run.missing.push(...batch.map((p) => p.id).filter((id) => !answered.has(id)));
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      run.missing.push(...record.pairIds);
    } finally {
      record.ms = Date.now() - started;
    }
  }));

  run.ms = Date.now() - t0;
  return run;
}

function sameLink(a: Link, b: Link): boolean {
  return a.pairId === b.pairId && a.s.join() === b.s.join() && a.t.join() === b.t.join();
}
