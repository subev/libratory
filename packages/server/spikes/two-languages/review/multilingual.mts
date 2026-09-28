import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseFile } from "music-metadata";
import { env } from "../../../src/env.ts";
import { cartesiaSynthesize, listCartesiaVoices } from "../../../src/lib/cartesia.ts";
import { readChunkWords } from "../../../src/lib/chunk-previews.ts";
import type { SyncMap } from "../../../src/lib/sync-map.ts";
import { linkByIds } from "../links-ids.mts";
import type { LinkPair, LinkRun } from "../links.mts";
import { tokenize, TOKENIZER } from "../tokens.mts";
import { timeline } from "../timing.mts";
import { fixtures } from "./multilingual-fixtures.mts";

const out = path.resolve(env.DATA_DIR, "tmp/two-languages-spike/multilingual");
mkdirSync(out, { recursive: true });
const call = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const refined = process.argv.includes("--refined");
const largeReasoning = process.argv.includes("--reasoning-large");
const thinking = process.argv.includes("--reasoning") || largeReasoning;
if (refined && thinking) throw new Error("Keep reasoning and prompt experiments separate");
const suffix = largeReasoning ? "-reasoning-large" : thinking ? "-reasoning" : refined ? "-refined" : "";
const maxOutputTokens = largeReasoning ? 81_920 : thinking ? 8192 : 4096;
const guidance = refined ? "Check for lexical meaning inside compounds: one written token may express several separately written words on the other side. Include each corresponding content word even if that compound token already has a link. Link grammatical tokens only when their grammatical function or contextual meaning corresponds; proximity alone is not a counterpart." : undefined;
const entries = fixtures.map((fixture) => {
  const sourceText = fixture.rows.map((r) => r.s).join("\n");
  const targetText = fixture.rows.map((r) => r.t).join("\n");
  let sAt = 0, tAt = 0;
  const pairs: LinkPair[] = fixture.rows.map((r, i) => {
    const s = { start: sAt, end: sAt + r.s.length }, t = { start: tAt, end: tAt + r.t.length };
    sAt = s.end + 1; tAt = t.end + 1;
    return { id: `p${i + 1}`, s, t, sTokens: tokenize(sourceText, s, fixture.sourceLocale), tTokens: tokenize(targetText, t, fixture.targetLocale) };
  });
  const checks = fixture.rows.flatMap((row, i) => {
    const pair = pairs[i];
    if (!pair) throw new Error("Missing fixture pair");
    const resolve = (needles: string[], side: "s" | "t") => needles.map((needle) => {
      const [text, nth = "1"] = needle.split("#");
      const original = side === "s" ? sourceText : targetText;
      const token = (side === "s" ? pair.sTokens : pair.tTokens)
        .filter((tok) => original.slice(tok.start, tok.end) === text)[Number(nth) - 1];
      if (!token) throw new Error(`Missing fixture token ${fixture.key}/${pair.id}/${side}/${needle}`);
      return token.id;
    });
    return row.checks.map((check) => ({ label: check.label, pairId: pair.id, s: resolve(check.s, "s"), t: resolve(check.t, "t") }));
  });
  return { ...fixture, sourceText, targetText, pairs, checks, fixtureHash: hash(JSON.stringify(fixture)), tokenizer: TOKENIZER };
});
writeFileSync(path.join(out, "fixtures.json"), JSON.stringify(entries, null, 2));

if (process.argv.includes("--links")) {
  if (thinking && (entries.length !== 2 || entries.some((e) => e.pairs.length !== 10 || e.sourceText.length + e.targetText.length > 1500))) {
    throw new Error("Fixture changed beyond the approved six-call reasoning budget");
  }
  for (const entry of entries) for (let run = 1; run <= 3; run++) {
    const dest = path.join(out, `${entry.key}-links-${run}${suffix}.json`);
    if (existsSync(dest)) continue;
    const result = await linkByIds(entry.pairs, entry.sourceText, entry.targetText,
      { from: entry.from, to: entry.to }, { modelKey: "flash", maxOutputTokens, guidance, thinking, timeoutMs: largeReasoning ? 1_800_000 : 600_000 });
    writeFileSync(dest, JSON.stringify({ fixtureHash: entry.fixtureHash, guidance: guidance ?? null,
      promptCodeHash: hash(readFileSync(new URL("../links-ids.mts", import.meta.url), "utf8")),
      requestedModel: "deepseek-flash", thinking, maxOutputTokens,
      createdAt: new Date().toISOString(), ...result }, null, 2));
    console.log(`${entry.key} run ${run}: ${result.links.length} links; missing ${result.missing.length}; invalid ${result.invalid.length}`);
  }
}

if (process.argv.includes("--audio")) {
  const paidCharacters = entries.reduce((n, e) => n + e.targetText.length + (e.sourceLocale === "en" ? 0 : e.sourceText.length), 0);
  if (paidCharacters > 4000) throw new Error("Audio exceeds the experiment's approved character budget");
  const voices = await listCartesiaVoices();
  for (const entry of entries) for (const side of ["source", "target"] as const) {
    const locale = side === "source" ? entry.sourceLocale : entry.targetLocale;
    const text = side === "source" ? entry.sourceText : entry.targetText;
    const base = `${entry.key}-${side}`;
    const wav = path.join(out, `${base}.wav`), syncPath = path.join(out, `${base}.sync.json`);
    if (existsSync(syncPath)) continue;
    const chunksDir = path.join(out, `${base}-chunks`);
    mkdirSync(chunksDir, { recursive: true });
    let voiceId: string, model: string;
    if (locale === "en") {
      voiceId = "af_heart"; model = "Kokoro-82M";
      const input = path.join(out, `${base}.txt`);
      writeFileSync(input, text);
      await call(path.join(env.CONDA_ENV_PATH, "python"), [path.join(env.SCRIPTS_DIR, "synthesize.py"),
        "--input", input, "--output", wav, "--voice", voiceId, "--chunks-dir", chunksDir],
      { env: { ...process.env, HF_HUB_OFFLINE: "1" }, timeout: 180_000, maxBuffer: 1024 * 1024 });
    } else {
      const voice = voices.find((v) => v.language.split(/[-_]/)[0] === locale);
      if (!voice) throw new Error(`No Cartesia voice for ${locale}`);
      voiceId = voice.id; model = "sonic-3.6";
      await cartesiaSynthesize({ inputText: text, outputPath: wav, voiceId, speed: 1, chunkPreviewDir: chunksDir,
        log: async (line) => { console.log(`${base}: ${line}`); } });
    }
    const manifest: { index: number; text: string }[] = JSON.parse(readFileSync(path.join(chunksDir, "chunks.json"), "utf8"));
    const chunks: SyncMap["chunks"] = [];
    let cursor = 0;
    for (const [i, chunk] of manifest.entries()) {
      const chunkPath = path.join(chunksDir, `chunk-${String(chunk.index).padStart(3, "0")}.wav`);
      const duration = (await parseFile(chunkPath, { duration: true })).format.duration;
      if (duration === undefined) throw new Error("Missing chunk duration");
      const endMs = cursor + Math.round(duration * 1000);
      const words = (await readChunkWords(chunksDir, chunk.index)) ?? [];
      chunks.push({ text: chunk.text, startMs: cursor, endMs,
        words: words.map((w) => ({ ...w, startMs: cursor + w.startMs, endMs: cursor + w.endMs })) });
      cursor = endMs + (locale !== "en" && i < manifest.length - 1 ? 250 : 0);
    }
    const totalMs = Math.round(((await parseFile(wav, { duration: true })).format.duration ?? 0) * 1000);
    writeFileSync(syncPath, JSON.stringify({ version: 2, totalMs, chunks, textHash: hash(text), voiceId, model, createdAt: new Date().toISOString() }, null, 2));
    console.log(`${base}: saved ${model}, ${voiceId}, ${totalMs} ms`);
  }
}

const summary = entries.map((entry) => {
  const runs = [1, 2, 3].flatMap((r) => {
    const file = path.join(out, `${entry.key}-links-${r}${suffix}.json`);
    if (!existsSync(file)) return [];
    const result: LinkRun & { fixtureHash: string } = JSON.parse(readFileSync(file, "utf8"));
    if (result.fixtureHash !== entry.fixtureHash) throw new Error("Stale link fixture");
    const relations = new Set(result.links.flatMap((l) => l.s.flatMap((s) => l.t.map((t) => `${l.pairId}:${s}-${t}`))));
    const checks = entry.checks.map((c) => ({ label: c.label, pairId: c.pairId,
      passed: c.s.every((s) => c.t.every((t) => relations.has(`${c.pairId}:${s}-${t}`))) }));
    const completed = result.missing.length === 0 && result.batches.every((b) => b.finishReason === "stop" && !b.error);
    return [{ run: r, completed, checks: completed ? checks : null, passed: completed ? checks.filter((c) => c.passed).length : null, total: checks.length,
      thinking, ms: result.ms, errors: result.batches.flatMap((b) => b.error ? [b.error] : []),
      reasoningTokens: result.batches.reduce((n, b) => n + (b.reasoningTokens ?? 0), 0),
      links: result.links, missing: result.missing, invalid: result.invalid, tokensIn: result.tokensIn, tokensOut: result.tokensOut }];
  });
  const audio = Object.fromEntries((["source", "target"] as const).map((side) => {
    const file = path.join(out, `${entry.key}-${side}.sync.json`);
    if (!existsSync(file)) return [side, null];
    const map: SyncMap & { textHash: string } = JSON.parse(readFileSync(file, "utf8"));
    const text = side === "source" ? entry.sourceText : entry.targetText;
    if (map.textHash !== hash(text)) throw new Error("Stale audio fixture");
    const tl = timeline(text, map);
    const tokens = entry.pairs.flatMap((p) => side === "source" ? p.sTokens : p.tTokens);
    const missing = tokens.filter((t) => !tl.words.some((w) => w.endMs > w.startMs && w.start < t.end && t.start < w.end)).map((t) => text.slice(t.start, t.end));
    const durations = tl.words.map((w) => w.endMs - w.startMs);
    const uniformIntervals = durations.length >= 10 && Math.max(...durations) - Math.min(...durations) <= 1;
    return [side, { file: `${entry.key}-${side}.wav`, totalMs: map.totalMs, words: tl.words,
      reportedWords: map.chunks.reduce((n, c) => n + (c.words?.length ?? 0), 0), locatedWords: tl.words.length,
      tokens: tokens.length, untimedTokens: missing, uniformIntervals,
      zeroDurationWords: tl.words.filter((w) => w.endMs <= w.startMs).map((w) => text.slice(w.start, w.end)) }];
  }));
  return { ...entry, runs, audio };
});
writeFileSync(path.join(out, `report${suffix}.json`), JSON.stringify(summary, null, 2));
const template = readFileSync(new URL("multilingual.template.html", import.meta.url), "utf8");
writeFileSync(path.join(out, `view${suffix}.html`), template.replace("__DATA__", () => JSON.stringify(summary).replaceAll("<", "\\u003c")));
console.log(JSON.stringify(summary.map((e) => ({ key: e.key, checks: e.runs.map((r) => r.completed ? `${r.passed}/${r.total}` : "incomplete; unscored"),
  audio: Object.fromEntries(Object.entries(e.audio).map(([side, a]) => [side, a && { located: a.locatedWords, reported: a.reportedWords, untimed: a.untimedTokens }])) })), null, 2));
