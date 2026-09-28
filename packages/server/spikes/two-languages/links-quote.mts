// Baseline for the comparison: the model quotes phrases and they are located in the text. Kept as it
// was measured (including its known locator faults — see review/failures.test.ts); located ranges
// are turned into token ids so both methods are scored the same way.
import { runLinks, type LinkPair, type LinkRun, type ParsedLine } from "./links.mts";
import type { Span } from "./segment.mts";
import type { Token } from "./tokens.mts";

const system = (from: string, to: string) => `You link words between ${from} sentences and their ${to} translations, for a language learner who taps a word to see its counterpart.

Link every word that carries meaning and has a counterpart: nouns, verbs, adjectives, adverbs, pronouns, names, numbers, fixed expressions. Skip articles, most prepositions and conjunctions, and auxiliary verbs unless they carry the meaning alone.

A link may join phrases when one language says in several words what the other says in one. Keep links as small as the meaning allows. A word with no counterpart gets no link.

Each side of a link must be copied EXACTLY and CONTIGUOUSLY from its sentence — same letters, case and inflection. When an expression is split by other words, link only its core word.

Answer with one line per link, in the order the words appear in the ${from} sentence, and nothing else:
<pair id><TAB><${from} phrase><TAB><${to} phrase>`;

export function linkByQuotes(pairs: LinkPair[], srcText: string, tgtText: string, languages: { from: string; to: string }): Promise<LinkRun> {
  // A phrase repeated inside one sentence takes its next occurrence, in the order the model lists them
  const seen = new Map<string, number>();
  const nth = (key: string) => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return n; };

  const parse = (line: string, batch: Map<string, LinkPair>): ParsedLine | null => {
    const m = LINE.exec(line);
    if (!m) return null;
    const pair = batch.get(m[1]!);
    if (!pair) return { invalid: line };
    const from = m[2]!.trim(), to = m[3]!.trim();
    const s = locate(srcText, pair.s, from, nth(`${pair.id}s${from.toLowerCase()}`));
    const t = locate(tgtText, pair.t, to, nth(`${pair.id}t${to.toLowerCase()}`));
    const sIds = s && idsIn(pair.sTokens, s), tIds = t && idsIn(pair.tTokens, t);
    if (!sIds?.length || !tIds?.length) return { invalid: line };
    return { pairId: pair.id, link: { pairId: pair.id, s: sIds, t: tIds } };
  };

  return runLinks(
    "quotes",
    pairs,
    system(languages.from, languages.to),
    (batch) => batch.map((p) => `${p.id}\n${languages.from}: ${srcText.slice(p.s.start, p.s.end)}\n${languages.to}: ${tgtText.slice(p.t.start, p.t.end)}`).join("\n\n"),
    parse,
  );
}

const LINE = /^\s*(p\d+)\s*(?:\t|\s*\|\s*|\s{2,})([^\t|]+?)(?:\t|\s*\|\s*|\s{2,})([^\t|]+?)\s*$/;

function idsIn(tokens: Token[], span: Span): number[] {
  return tokens.filter((t) => t.start < span.end && span.start < t.end).map((t) => t.id);
}

// The nth whole-word occurrence of a phrase inside its sentence
function locate(text: string, sentence: Span, phrase: string, nth: number): Span | null {
  if (!phrase) return null;
  const hay = text.slice(sentence.start, sentence.end);
  for (const [h, p] of [[hay, phrase], [hay.toLowerCase(), phrase.toLowerCase()]] as const) {
    let seen = 0;
    for (let at = h.indexOf(p); at !== -1; at = h.indexOf(p, at + 1)) {
      const edge = (c: string | undefined) => !c || !/[\p{L}\p{N}]/u.test(c);
      if (edge(h[at - 1]) && edge(h[at + p.length]) && ++seen === nth) {
        return { start: sentence.start + at, end: sentence.start + at + p.length };
      }
    }
  }
  return null;
}
