# Bilingual reader review checkpoint

2026-09-28. Branch: `feat/bilingual-reader`, based on
`f1d0493af11dc88a3d956185536f6db8538ef04f`.

This checkpoint includes the implementation, original spike, prior reviews, design reference and
continuation notes. Compare the branch with the base above to review the complete change. The
spike and earlier reviews are historical context, not all new implementation from this pass.
No paid model or voice calls were made during implementation. Generated recordings, EPUB examples
and reports remain gitignored local data; the commit does not carry them.

## Scope and entry points

This slice adds an optional bilingual document to `p2af/1`, packages it with an EPUB, and reads it
offline in the existing web reader. Three saved examples enter through `/open`.

- `packages/server/src/lib/bilingual-format.ts`: schema, content hashes, grapheme-aligned UTF-16
  ranges, token references, independent clocks and unresolved mappings.
- `packages/server/src/lib/readaloud-epub.ts`: optional resources, source text binding to primary
  cues, source recording identity, and hashes of the actual staged audio before archiving.
- `packages/web/src/lib/reader-source.ts`: HTTP/container consumption and audio URL lifetime.
- `packages/web/src/pages/Reader.tsx` and `ReaderOpen.tsx`: mode choice, chapter/file changes,
  asynchronous document identity, and handoff to ordinary reading.
- `packages/web/src/components/reader/BilingualReader.tsx`, `WordMeaning.tsx`, and
  `packages/web/src/lib/bilingual-reading.ts`: rendering, playback, inspection and text layout.
- `packages/server/spikes/two-languages/review/export-reader.mts`: local adapter over saved spike
  data. Requires recordings/results already on this machine and ffmpeg; not a fresh-clone fixture.

See `docs/bilingual-format.md` for the wire contract and
`docs/two-languages-implementation-plan.md` for the remaining implementation phases.

## Interaction requirements

Prepared chapters open bilingual by default. An explicit single-language choice survives chapter
changes; opening another file clears chapter/language/time from the previous file. Paragraphs flow
without repeated sentence headers. Wide screens show two columns; narrow screens stack passages.
Each lane determines its own text direction.

Click/tap plays from the chosen word in its own language. Hover/focus previews the equivalent;
touch can hold or enable “Meanings on tap.” Tooltips prefer above the word and fall below when the
toolbar leaves insufficient space. Automatic following pauses while a meaning is open. Space
pauses/resumes, including with a word focused; Enter plays the focused word. Input controls retain
their own Space behavior.

A “Play clicked word only” experiment was implemented and then **removed at the user’s request**:
its acoustic boundaries felt too imprecise. Keep continuous click-to-listen; do not reintroduce word
clipping or its checkbox as part of the next implementation slice.

## Review findings addressed

- Punctuation absorption is capped at the next token: contractions and separate punctuation tokens
  render exactly once. Pair tokens/gaps and passage anchors are computed once per document instead
  of repeating nested scans on playback ticks.
- Export verifies the source text against primary cue text, requires source narration to reference
  primary audio, and compares SHA-256 revisions with the staged recordings. The client only carries
  milliseconds between modes when audio references match. The client does not hash entire audio.
- Grapheme boundaries protect combining marks and joined emoji as well as surrogate pairs.
- Web dependencies on Zod and noble hashes are declared; the exporter-only test config has a
  `test:reader` script. Malformed optional references no longer break ordinary reading.
- The plan records the user's click-to-listen decision. Its phase-1 gate now distinguishes export
  snapshot checks from future database/job staleness protection.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test --maxWorkers=2
pnpm --filter @libratory/web test
pnpm --filter @libratory/server test:reader
pnpm --filter @libratory/web build
node e2e/scripts/bilingual-reader.mjs
```

The focused browser script needs the dev web server on port 3033 and saved examples under
`packages/server/data/tmp/bilingual-reader/`. It covers three language pairs, default mode,
hover/keyboard/touch behavior, Space, narrow RTL, offline playback,
single-language handoff and opening another book. It is separate from the full E2E suite.
The web suite has 146 tests and the filesystem-only exporter suite has nine. Existing lint/build
warnings remain. The full suite passed with `pnpm test --maxWorkers=2`: 922 server, 146 web and
38 desktop tests (1,106 total). The first unrestricted run hit three database-cleanup hook timeouts
and one OCR fixture timeout; limiting concurrency passed without changing tests or their timeouts.
Repository lint and typecheck passed before the checkpoint commit.

## Still open

- No production preparation jobs, database state/migrations, cancellation/retry UI, stale-job
  publication guard, live manifest attachment or normal export selection yet. This is the next slice.
- No native bilingual reader or chapter-modal integration. Existing Swift decoder compatibility
  was checked for primary manifests/cues, not native import/playback.
- Every word remains a tab stop. The reader still reconciles the chapter during playback; nested
  scans are removed, but long-chapter profiling and more selective rendering remain necessary.
- Mapping quality evidence comes from small, partly self-labelled examples. Provider timings are
  unverified, including suspiciously uniform Hebrew intervals and zero-duration words. Zero-duration
  anchors never become active-word highlights.
- PDF passage pairing, verse/complex layout, whole-book scheduling and final format compatibility
  remain open. Text-only bilingual exports without primary cues are not supported by this slice.

Please review correctness and regressions within this scope, especially addressing, timing identity,
resource lifetime, mixed-direction text and playback interactions. Do not infer that successful
fixtures establish multilingual alignment accuracy or that production preparation is implemented.

## Resume in the next session

1. Read this handoff, then `docs/two-languages-implementation-plan.md` and
   `docs/bilingual-format.md`. Check `git status` and stay on `feat/bilingual-reader`.
2. Open an existing sample in the web reader at `http://127.0.0.1:3033/open` if useful. Files are
   `packages/server/data/tmp/bilingual-reader/en-bg.epub`, `en-he.epub` and `bg-de.epub`.
   The current viewer is the actual web reader; the older spike HTML viewers are research artifacts.
3. Continue phase 3: connect one real chapter and its existing translation to explicit preparation,
   persisted pairing/link state, and normal manifest/export attachment. Inspect current chapter,
   variant, job and narration invalidation paths before choosing the schema. Use the repository's
   migration generator; preserve independent text and narration revisions and reject stale job
   publication. Jobs fail once; retries are explicit. Opening the reader never queues processing.
4. Keep the reader as the main experience. Add a small contextual chapter-modal link after the
   normal flow works. Do not recreate the design board's full UI, start a model sweep, or expand into
   native reader work yet. The design is advisory; the user's interaction decisions above govern.

The broader objective remains a reusable bilingual EPUB/p2af foundation that the iPhone reader can
consume offline. The current slice proves consumption/export, not preparation or native support.
Keep the tested token-ID prompt with reasoning off. Further paid experiments, large agent fan-outs,
heavy downloads and full E2E runs need separate approval under the user's standing preferences.
Future commits also need approval; this checkpoint's authorization does not cover tomorrow's work.
