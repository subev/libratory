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
offline in the existing web reader. Production per-chapter preparation now persists existing translations,
serves live reader documents and attaches current prepared translations to original-language synced
EPUB exports. Three saved research examples also enter through `/open`.

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

## Sentence alternation follow-up

An unchecked “Alternate languages by sentence” checkbox plays the selected language, its matched
counterpart, then the next sentence in the same order. Enabling it restarts the current sentence
without starting audio if paused. Clicking a word or selecting a voice resets the sequence to that
language and passage. Space pauses/resumes. Unchecking continues the current recording normally.
Sentence groups use existing paired passages (a merge can contain more than one sentence).
Missing/uncertain pairs or unusable timings stop with an explanation; the final pair stops the
chapter rather than looping or changing chapters. Both narrations must be available to enable it.
The word-only clipping experiment remains removed. The follow-up passed 149 web tests, repository
lint/typecheck and focused browser checks for order, pause/resume, disabling the mode and chapter end.

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

## Production preparation follow-up

Migration `0046_typical_annihilus.sql` adds `bilingual_preparations`, keyed to a translation.
Sentence artifacts and word links are separate JSON records; job states and raw model answers stay
on the preparation side. No schema or model experiment replaces the reading contract.

- `lib/bilingual-segment.ts`, `bilingual-align.ts`, `bilingual-timing.ts`: production ports of the
  measured algorithms, with checked indexing and format validation. Scoring remains heuristic.
- `lib/bilingual-links.ts`: tested token-ID wording, reasoning off, bounded sequential batches,
  no automatic retries, per-sentence validation and finish-reason rejection. Global persisted lane
  IDs replace per-sentence temporary IDs. No new model-quality claim is made for that addressing change.
- `workers/prepare-bilingual.ts`, `lib/bilingual-store.ts`: queued text hashes, run identity,
  publication locks/rechecks, retained completed batches, explicit retry and cancellation. The current
  in-flight call may finish after Stop, but cannot publish. Startup sweep marks interrupted work
  failed rather than replaying paid calls. Pairing uses the existing optional search bundle only.
- `routes/bilingual.ts`, `components/BilingualPreparation.tsx`: chapter translation controls,
  local pairing, model selection and approximate token budget for explicit word linking. Opening
  the reader does not queue work. The chapter player supplies its actual clock; paired passage
  timing carries that context to the original clock. Missing timing starts at the beginning.
- `lib/bilingual-document.ts`, `reader-doc.ts`, `p2af.ts`: current-text references, on-demand timing
  from sync maps, audio byte hashes, live documents and normal export attachments. Changed text
  hides the old preparation; changed audio rebuilds timing without regenerating text links.

To use: open a completed translation in the chapter modal, expand **Bilingual reading**, choose
**Pair sentences**, then optionally **Link words** with the chosen model. **Open bilingual reader**
works once pairs exist, even without narration or word links. Export the original-language synced
EPUB to include current prepared translations for its exported, narrated chapters. Translation-only
exports continue to have their own single primary lane. No user-model call or download was run in
this implementation pass.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test --maxWorkers=2
pnpm --filter @libratory/web test
pnpm --filter @libratory/server test:reader
pnpm --filter @libratory/web build
node e2e/scripts/bilingual-reader.mjs
node e2e/scripts/bilingual-preparation.mjs
```

The focused browser script needs the dev web server on port 3033 and saved examples under
`packages/server/data/tmp/bilingual-reader/`. It covers three language pairs, default mode,
hover/keyboard/touch behavior, Space, narrow RTL, offline playback,
single-language handoff and opening another book. It is separate from the full E2E suite.
The current full suite passed with `pnpm test --maxWorkers=2`: 941 server, 149 web and
38 desktop tests (1,128 total). Lint and typecheck passed with warnings (including copied-array reverse calls for the ES2022 type target). The new 19
preparation tests use mocked models and isolated databases. They cover text changes while queued
and running, cancellation/run fencing, malformed batches, explicit resume, restart recovery,
audio replacement and normal export attachment. The focused controls browser test uses a mock API
and checks explicit actions, cost display, Stop, narrow layout and passage navigation without user
data changes or provider charges. Saved-recording reader checks cover all three language pairs.
The historical unrestricted suite hit database/OCR fixture timeouts; two workers pass without
changing tests or their timeouts.

## Still open

- Production orchestration is covered with mocked models; a newly prepared real chapter through
  the live UI and a real full-book export still need an acceptance pass. No fresh paid linking
  was run. The research samples retain their previously generated links and recordings.
- No native bilingual reader. Existing Swift decoder compatibility
  was checked for primary manifests/cues, not native import/playback.
- Every word remains a tab stop. Sentence passages now skip reconciliation when their text,
  highlights and interactions are unchanged; the first real long-chapter before/after is recorded.
  The reader shell still updates on ticks, and larger-book/mobile profiling remains open.
- Mapping quality evidence comes from small, partly self-labelled examples. Provider timings are
  unverified, including suspiciously uniform Hebrew intervals and zero-duration words. Zero-duration
  anchors never become active-word highlights.
- PDF passage pairing, verse/complex layout, whole-book scheduling and final format compatibility
  remain open. Text-only bilingual exports without primary cues are not supported by this slice.

Please review correctness and regressions within this scope, especially addressing, timing identity,
resource lifetime, mixed-direction text and playback interactions. Do not infer that successful
fixtures establish multilingual alignment accuracy or native bilingual support.

## Resume in the next session

1. Read this handoff, then `docs/two-languages-implementation-plan.md` and
   `docs/bilingual-format.md`. Check `git status` and stay on `feat/bilingual-reader`.
2. Open an existing sample in the web reader at `http://localhost:3033/open` if useful. Files are
   `packages/server/data/tmp/bilingual-reader/en-bg.epub`, `en-he.epub` and `bg-de.epub`.
   The current viewer is the actual web reader; the older spike HTML viewers are research artifacts.
3. Exercise the normal per-chapter path against an existing translation and installed search bundle.
   A deliberate Link words click uses the selected provider; do not run a paid experiment silently.
   Check fresh export/import, editing/re-pairing and re-narration against real audio. The generated
   migration is applied by normal server startup; it has been exercised in isolated test databases.
4. Continue the phase-4 selection workflow and realistic book-size performance/export checks after
   that acceptance pass. Keep the reader as the main experience; the modal is only a preparation
   and navigation entry. Native/PDF pairing remains later work.
5. Preserve useful labelled fixtures and migrate the saved-recording browser examples before
   removing the spike and adapter. Production runtime has no spike imports, but the current saved
   browser samples still come from that adapter. Keep the task open until cleanup is complete.

The broader objective remains a reusable bilingual EPUB/p2af foundation that the iPhone reader can
consume offline. Keep the tested token-ID prompt with reasoning off. Further paid experiments,
large agent fan-outs, heavy downloads and full E2E runs need separate approval under the user's
standing preferences. The user authorized continuing and committing this preparation checkpoint;
no push was requested.

## Real-data acceptance follow-up

See [real chapter acceptance](bilingual-reader-acceptance.md). The normal local pairing job prepared
The Three Sisters (253 groups, 8,219 stored tokens across both lanes). Production builders exported
that chapter and the already word-linked LETTER I.; both passed offline browser playback. No paid
calls. Long-chapter playback exposed substantial JavaScript cost, so selective rendering is now
supported by a concrete baseline rather than only a review concern. The report records remaining
gates and reproducible local artifact checks.

Assistant/MCP parity is an explicit requirement in phase 6 of the delivery plan, including local
sentence-level and optional word-linked workflows. Audit found preparation/status/cancel,
translated-lane narration and per-request translation model selection missing from the shared tool
surface. The user clarified that this belongs after the rest of the reader workflow is ready;
the earlier budget question is superseded, not pending. Do not start MCP work next or treat this
audit as an implemented capability. Next is desktop lifecycle and whole-book acceptance, native consumption, MCP parity and final cleanup.

## Playback rendering follow-up

`BilingualPassage` memoizes sentence text, with stable word/meaning handlers and link arrays.
Ordinary playback updates highlighted passages rather than reconstructing every word button.
The same 8,219-token chapter now spends about 0.85–0.88 seconds running JavaScript per five-second
playback sample, down from 3.26–3.41 seconds. Frame p95 fell from 50 ms to about 16.8 ms in headless
Chromium on the development build. No React Compiler is enabled. No virtualization, imperative
DOM highlighting or custom comparison that ignores callbacks was introduced.

Voice changes and alternation still update handlers when their state changes. Existing browser
checks cover hover, keyboard, touch and alternation; the real-export script now also seeks between
distant words and checks that exactly one active-word mark moves to the correct token. See the
acceptance report for measurements and remaining limits.

## User-reported token error follow-up

The saved failed Flash response mixed lane IDs in unlinked declarations (`p4: 41 = -`)
and included a real invalid link (`p6: 98 = 99`, both IDs from the target lane).
Opening sentence-level reading did not cause this. The parser now ignores numeric unlinked
declarations, which create no stored references, but validates every actual link against its
own sentence and lane. Valid sentence groups survive an invalid group; the job still fails once,
and explicit retry requests only missing groups. Unknown pair IDs/unassignable lines and truncated
responses still reject the whole batch. Replaying the saved response locally preserves nine of ten
groups and rejects p6. Successful later attempts were left untouched; no paid calls were made.

## Independent review fixes

See [the finding-by-finding response](bilingual-reader-review-response.md) alongside the original
[bilingual reader review findings](bilingual-reader-review-findings.md). Both blockers and S1–S5
are addressed in the follow-up checkpoint, including real cue-to-EPUB regression coverage and interruptible
alignment. The response distinguishes CPU responsiveness from total alignment cost and records
remaining performance/compatibility work. It also covers the separately reported Flash token-ID error.

The [simplification review](bilingual-reader-simplify-findings.md) was also read. Its missed async
validation bug is fixed with a synchronous parser and a regression that previously reproduced the
unhandled rejection/publication. Cancellation queries, streaming file hashing and passage indexes
are simplified, with shared grapheme/token helpers and speed subscription. The response records
which suggestions were applied, retained deliberately or deferred to measured long-chapter work.

## Keyboard and recovery follow-up

The reader now remembers one word Tab stop per language. Left/Right move within that language's
reading direction (reversed for RTL); Home/End reach the first/last word. Enter listens and Space
pauses/plays. Hover/focus meanings remain available; playback never moves keyboard focus.

A failed, invalid, wrong-chapter or missing bilingual attachment opens the original reader with a
notice. An explicit retry preserves the current original recording position; there is no automatic
retry. Chapters with no attachment can still navigate to a prepared chapter.
`node e2e/scripts/bilingual-resilience.mjs` checks these paths, two Tab stops, LTR/RTL navigation and
keyboard playback using a generated range-capable WAV fixture. No database or paid provider is used.
The three saved multilingual examples also pass their existing browser checks. Lint, typecheck and
all 1,142 unit/integration tests pass. Desktop lifecycle and native acceptance remain open.
