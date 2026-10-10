# Review: chunk_fit (510-phoneme split by text) - 2026-10-11

Scope: `git diff scripts/synthesize.py AGENTS.md`, `scripts/chunk_fit.py`,
`packages/server/src/lib/chunk-fit.test.ts`. Reviewed by an agent, read-only; no code changed.
The test file passes (5/5, `npx vitest run src/lib/chunk-fit.test.ts`).

## Findings (by severity)

### 1. Low-medium: resume guard trusts a manifest rewritten before the audio exists
`scripts/synthesize.py:220-222` reads the old manifest, then immediately overwrites `chunks.json`
with the new cut, before any chunk is synthesized. Failing sequence:
1. Run 1 (old cut) leaves `chunk-001..N.wav` and manifest M1.
2. Run 2 (new cut) reads M1, writes M2, rejects mismatched indices, re-synthesizes from, say,
   index 1..3, then is killed (dev restart, cancel, crash).
3. Run 3 reads M2 as "cached". Index 5 text in M2 equals the new cut's text, but
   `chunk-005.wav` is still run 1's audio for a different text. The guard passes and the wrong
   audio is spliced in (and its stale `chunk-005.words.json` is used, so timings are wrong too).
Fix: remove (or skip when writing) `chunk-NNN.wav`/`.words.json` for indices whose cached text
differs, or write the manifest only as chunks complete. Not hit by the verified by-hand case
(a single resume), only by resume-after-interrupted-resume across a cut change. Impact is
confined to the one-time upgrade of books half-synthesized under the old cut.

### 2. Low: one failing half drops the whole sentence
`scripts/synthesize.py:202-206`: `fit_chunks` is all-or-nothing inside the `try`. A g2p exception
on any recursive half (`chunk_fit.py:76,85-86`) loses the entire sentence, logged only to stderr
as "G2P error on segment" (same net effect as before for a failing g2p on the segment, but
previously g2p ran once per sentence; now it runs 2+ more times on sub-strings, so there is more
chance of it). The narration silently skips the sentence. Acceptable per the old contract; worth
knowing. Repro: a g2p that raises on strings starting with a quote.

### 3. Low: test gaps (`chunk-fit.test.ts`)
- `en_tokenize` is faked as a single chunk (line 14). The multi-chunk English path
  (`chunk_fit.py:78-87`, an over-limit chunk among several) is never exercised. I ran it by hand
  with a 30-words-per-chunk tokenizer: 27 pieces, all within the limit, no error.
- No case for the nearest-space fallback (no clause punctuation in the middle half; the
  `_SPACE` branch, lines 31-35) or for the middle-half rule (an early comma must be ignored).
- No test of `synthesize.py` integration: `chunk_espeak` expression (line 213) and
  `cached_chunk_texts`/`load_existing_chunk` (lines 128-148) are untested. The resume guard is
  pure Python and could take a small test.
- The fake g2p makes phonemes == text, so it cannot catch phoneme count growing under g2p of
  a half (see "fine" below).
- Test shells to `python3` from PATH; fine locally, depends on CI image having it.

### 4. Nit: hard-cut pieces repeat the text
`chunk_fit.py:43-55`: for a no-space run, each piece carries the full text, so the sync map
still carries it N times. This is the pre-existing behaviour and the docs say so ("still cut in
its phonemes"), but the AGENTS.md line implies the duplication is fixed in general; it is fixed
except in this case.

## Checked and fine
- Termination: every recursive call receives a strictly shorter, stripped, non-empty text
  (`split_text` returns None when either side is empty, line 37-38), so depth is bounded by
  length. Verified with a 300-word input at limit 50 (no pathological growth, pieces 35-37).
- `split_text` off-by-one: cuts at `m.end()` so the clause punctuation stays left and spaces are
  stripped; `0 < m.start()` and `cut < len(text)` prevent empty halves. `"a b"`->(a,b), `"ab"`->
  None, `" x, y"`->(`x,`,`y`). Spaced dash keeps the dash on the left piece; fine.
- Empty/whitespace: `fit_chunks` returns `[]` for blank espeak phonemes and skips blank English
  chunks; the old `if ps.strip()` behaviour is preserved.
- `chunk_espeak` flag (`synthesize.py:213`): `timed and tks is None and has_word_spaces(gs)`
  reproduces the old value for unsplit espeak segments and gives False for English and hard cuts,
  as before.
- Manifest: `chunk_texts` now holds one text per piece (halves), the shape `write_chunk_manifest`
  expects; the old duplicated-text entries only remain for hard cuts. `cached_chunk_texts` is
  read before the manifest is overwritten (line 220 vs 222), and tolerates a missing or
  malformed file (returns [], so everything re-synthesizes).
- Index math: `cached_texts[index - 1]` with `index > len` guard is correct for 1-based indices.
- The no-chunks-dir path returns None early as before.

## Verification gaps
- I did not run real Kokoro or g2p; relied on the stated verification. Not checked: whether
  g2p of a half can exceed the phoneme count of its parent text (impossible to rule out in
  general for espeak; the recursion would handle it anyway since each half is re-checked).
- Did not check whether the TS side clears the chunks dir before a fresh run (relevant to
  finding 1); a grep of kokoro.ts/synthesize.ts found no chunks.json handling.
- Prosody effect of cutting a sentence at a clause and reading halves separately (context loss
  for g2p, e.g. quotes spanning the cut) is unassessed.
- AGENTS.md line (diff line ~905) is accurate against the code; it does not mention the resume
  guard (`cached_chunk_texts`), which a reader of that section may want.
