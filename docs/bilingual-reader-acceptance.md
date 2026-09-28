# Real chapter acceptance and playback baseline

2026-09-28, `feat/bilingual-reader`, after review checkpoint `e85b5f5`.
Existing library texts and recordings only; no translation, word-link or voice API calls.

## Real preparation and export

Queued **The Three Sisters** through `bilingual.prepare`, stage `pairs`, using its existing
English source and Bulgarian translation. The normal worker used the installed local BGE-M3
bundle: 524 sentence inputs became 253 matched groups. No word links were requested. “Matched”
is the algorithm's status, not an independent accuracy judgement.

Exported that chapter and the already word-linked **LETTER I.** with the production
`buildReadaloudEpub` + `buildP2afLayer` path, reading current database rows and real sync maps/audio.
The first export also carries the book's source PDF. Output files are local acceptance artifacts,
not new entries in the library's Outputs tab. Existing text, audio and word links were not replaced;
the new sentence preparation remains available in the chapter UI.

| Chapter | Pairs | Word-linked groups | Tokens across both lanes | Export | Builder elapsed |
| --- | ---: | ---: | ---: | ---: | ---: |
| The Three Sisters | 253 | 0 | 8,219 | 27.95 MB | 2.54 s |
| LETTER I. | 52 | 52 | 2,300 | 15.27 MB | 0.34 s |

Both include both recordings. The long chapter has roughly 21:45 of source audio and 28:01 of
translation audio. Its legacy book has no language set, so preparation correctly retains `und`
rather than inventing English. Visual inspection caught Chromium displaying that tag as “root”;
the language label now explicitly says “Unknown language.” The source text is English by inspection,
not because the application's metadata established it. Library metadata was left unchanged.

## Offline checks and rendering baseline

The focused Chromium script imports each real EPUB through `/open`, then disables networking.
It checks all stored word tokens render, both voices play through the single audio element, Space
pauses, saved word meanings appear without starting playback, narrow layout stays within 393 px,
and returning to single-language reading works. No page errors occurred. The long chapter's
Bulgarian recording lacks usable word timing at the chosen location, so clicking falls back to its
sentence start and says so; sentence pairing does not manufacture acoustic word boundaries.

Measured on the running **development build**, 1280×900 headless Chromium, one five-second
sample per lane with automatic following suspended. These are a diagnostic baseline, not a
production/mobile performance guarantee:

| Chapter | Import to bilingual view | JavaScript during 5 s playback | Frame interval p95 | Worst interval |
| --- | ---: | ---: | ---: | ---: |
| The Three Sisters | 1.21 s | 3.26–3.41 s | 50 ms | 150 ms |
| LETTER I. | 0.90 s | 1.38 s | 16.8 ms | 66.7 ms |

The first-run numbers above are retained as the baseline; subsequent runs vary with machine load.
Layout time was under 1 ms in these samples. The large JavaScript cost and the current render path
support addressing whole-chapter reconciliation before making a whole-book performance claim.
That diagnosis led to the passage-rendering change below. Alignment scoring and storage were not
changed to solve a client rendering problem.

## Passage rendering improvement

Sentence text now lives in a memoized `BilingualPassage`. Event handlers remain stable across
ordinary playback ticks; speaking, counterpart and inspected token props change only for affected
passages. The reader shell still updates its clock and performs timing lookups. Voice changes,
inspection mode and sentence alternation refresh the callbacks with their current state.

The same uncontended five-second development-build samples after the change:

| Chapter | JavaScript before | JavaScript after | Frame p95 before | Frame p95 after |
| --- | ---: | ---: | ---: | ---: |
| The Three Sisters | 3.26–3.41 s | 0.85–0.88 s | 50 ms | 16.8 ms |
| LETTER I. | 1.38 s | 0.49–0.52 s | 16.8 ms | 16.8 ms |

The first long-chapter rendering bottleneck is substantially reduced (about 74% less JavaScript
time in that sample). These short desktop samples do not establish whole-book or iPhone performance.
No binary-search timeline, virtualization or delegated-event framework was needed for this gain.
The existing three-language-pair browser checks cover click/hover, touch inspection, language
switches, Space after playback end and sentence alternation. The real-export script also checks
highlight movement between the first and last timed words, including removing the old mark.

## Reproduction and remaining gates

Local artifacts: `packages/server/data/tmp/bilingual-acceptance/` contains `long.epub`,
`linked.epub`, their bilingual JSON, export/browser reports and narrow screenshots. They are
gitignored and contain user library data. With the web dev server on localhost:3033:

```sh
node e2e/scripts/bilingual-acceptance.mjs
```

The script accepts another artifact directory as its first argument. Use two one-chapter
original-language synced EPUB exports named `long.epub` and `linked.epub`, with the latter carrying
word links and both carrying two playable narrations. Extract each single bilingual attachment:

```sh
unzip -p long.epub 'OEBPS/p2af/bilingual/*.json' > long.json
unzip -p linked.epub 'OEBPS/p2af/bilingual/*.json' > linked.json
```

This closes real local pairing and production-builder/offline-playback evidence for individual
chapters. It does **not** close fresh paid linking quality, live export-job orchestration, whole-book
selection/scheduling, edit/re-narration acceptance or native bilingual import. The existing tests
cover revision fencing and independent invalidation with mocked providers.

The user also made assistant/MCP coverage an explicit delivery requirement. The updated delivery
plan records local sentence-level and optional word-linked recipes, capability/cost handling and
the missing tool surface. Implement that through the same routes and jobs as the UI.

Checkpoint validation: lint and typecheck pass; 1,142 unit/integration tests pass with
`pnpm test --maxWorkers=2`. The focused real-export browser check passes, including the corrected
unknown-language label. The repeat profile taken during the test suite was slower on the long
chapter (frame p95 roughly 67 ms), so use the uncontended first run above as the baseline.
