import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { env } from "../../../src/env.ts";
import type { LinkPair, LinkRun } from "../links.mts";

type Probe = [string, string, string];
type Entry = { key: string; sourceText: string; targetText: string; pairs: LinkPair[];
  checks: { label: string; pairId: string; s: number[]; t: number[] }[] };
type Saved = LinkRun & { thinking?: boolean; fixtureHash: string };
const dir = path.resolve(env.DATA_DIR, "tmp/two-languages-spike/multilingual");
const entries: Entry[] = JSON.parse(readFileSync(path.join(dir, "fixtures.json"), "utf8"));

// Fixed before inspecting reasoning output. These catch selected wrong word-level relations,
// not all errors; grammatical disagreements are reported separately from content confusions.
const forbidden: Record<string, Probe[]> = {
  "en-he": [
    ["p1", "boy", "לילדה"], ["p1", "girl", "הילד"],
    ["p2", "light", "כיבתה"], ["p2", "turned", "האור"],
    ["p3", "her", "איתה"], ["p3", "her#2", "שלה"],
    ["p4", "not", "פתח"], ["p5", "bank", "גדת"], ["p5", "bank#2", "הבנק"],
    ["p5", "river", "הבנק"], ["p6", "small", "הקטנה"], ["p6", "small#2", "הקטן"],
    ["p7", "gave", "נתן"], ["p7", "gave#2", "נתנה"],
    ["p9", "platform", "יוצאת"], ["p10", "school", "הביתה"],
  ],
  "bg-de": [
    ["p1", "Момчето", "Mädchen"], ["p1", "момичето", "Junge"],
    ["p2", "лампата", "schaltete"], ["p2", "изключи", "Lampe"],
    ["p3", "ѝ", "ihr"], ["p3", "нея", "ihre"],
    ["p4", "не", "öffnete"], ["p5", "Банката", "Flussufers"], ["p5", "брега", "Bank"],
    ["p6", "Малкото", "kleine#2"], ["p6", "малкото", "kleine"],
    ["p7", "даде", "gab#2"], ["p7", "даде#2", "gab"],
    ["p9", "перон", "fährt"], ["p10", "училище", "Hause"],
  ],
};
const grammar: Record<string, Probe[]> = {
  "en-he": [["p2", "the", "את"], ["p4", "the", "את"]],
  "bg-de": [],
};
// Post-hoc diagnostic: the final large-budget German run grouped separable adjective/noun pairs.
// These are overly broad hover counterparts, even though the whole phrases translate correctly.
const granularity: Record<string, Probe[]> = {
  "en-he": [],
  "bg-de": [["p6", "Малкото", "Junge"], ["p6", "момче", "kleine"],
    ["p6", "малкото", "Mädchen"], ["p6", "момиче", "kleine#2"]],
};

function resolve(entry: Entry, [pairId, s, t]: Probe): string {
  const pair = entry.pairs.find((p) => p.id === pairId);
  if (!pair) throw new Error(`Missing pair ${pairId}`);
  const id = (needle: string, side: "s" | "t") => {
    const [word, nth = "1"] = needle.split("#");
    const text = side === "s" ? entry.sourceText : entry.targetText;
    const token = (side === "s" ? pair.sTokens : pair.tTokens)
      .filter((tok) => text.slice(tok.start, tok.end) === word)[Number(nth) - 1];
    if (!token) throw new Error(`Missing probe token ${entry.key}/${pairId}/${needle}`);
    return token.id;
  };
  return `${pairId}:${id(s, "s")}-${id(t, "t")}`;
}

const result = entries.map((entry) => ({ key: entry.key, variants: ["baseline", "reasoning", "reasoning-large"].map((variant) => {
  const runs = [1, 2, 3].flatMap((i) => {
    const file = path.join(dir, `${entry.key}-links-${i}${variant === "baseline" ? "" : `-${variant}`}.json`);
    if (!existsSync(file)) return [];
    const run: Saved = JSON.parse(readFileSync(file, "utf8"));
    const completed = run.missing.length === 0 && run.batches.every((b) => b.finishReason === "stop" && !b.error);
    const edges = new Set(run.links.flatMap((l) => l.s.flatMap((s) => l.t.map((t) => `${l.pairId}:${s}-${t}`))));
    const matched = (c: Entry["checks"][number]) => c.s.every((s) => c.t.every((t) => edges.has(`${c.pairId}:${s}-${t}`)));
    const bad = (forbidden[entry.key] ?? []).filter((p) => edges.has(resolve(entry, p)));
    const questionable = (grammar[entry.key] ?? []).filter((p) => edges.has(resolve(entry, p)));
    const readable = run.links.map((link) => {
      const pair = entry.pairs.find((p) => p.id === link.pairId);
      if (!pair) throw new Error("Unexpected output pair");
      const words = (ids: number[], side: "s" | "t") => ids.map((id) => {
        const tok = (side === "s" ? pair.sTokens : pair.tTokens).find((t) => t.id === id);
        if (!tok) throw new Error("Unexpected output token");
        return (side === "s" ? entry.sourceText : entry.targetText).slice(tok.start, tok.end);
      });
      return { pair: link.pairId, source: words(link.s, "s"), target: words(link.t, "t") };
    });
    return [{ run: i, completed, checksPassed: completed ? entry.checks.filter(matched).length : null, checksTotal: entry.checks.length,
      missed: completed ? entry.checks.filter((c) => !matched(c)).map((c) => c.label) : null,
      wrongContentProbes: completed ? bad : null, contentProbesTested: completed ? (forbidden[entry.key] ?? []).length : 0,
      questionableGrammar: completed ? questionable : null, ms: run.ms, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
      posthocOverbroadCounterparts: completed ? (granularity[entry.key] ?? []).filter((p) => edges.has(resolve(entry, p))) : null,
      reasoningTokens: run.batches.reduce((n, b) => n + (b.reasoningTokens ?? 0), 0),
      responseModels: [...new Set(run.batches.map((b) => b.responseModel).filter(Boolean))],
      missing: run.missing, invalid: run.invalid, finishReasons: run.batches.map((b) => b.finishReason), readable }];
  });
  return { variant, runs };
}) }));
writeFileSync(path.join(dir, "reasoning-comparison.json"), JSON.stringify(result, null, 2));
const template = readFileSync(new URL("reasoning.template.html", import.meta.url), "utf8");
writeFileSync(path.join(dir, "comparison.html"), template.replace("__DATA__", () => JSON.stringify(result).replaceAll("<", "\\u003c")));
console.log(JSON.stringify(result.map((e) => ({ ...e, variants: e.variants.map((v) => ({ ...v,
  runs: v.runs.map(({ readable: _readable, ...rest }) => rest) })) })), null, 2));
