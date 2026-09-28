# Two Languages — read one, hear the other

A language-learning mode: a chapter and its translation side by side, paired sentence by sentence,
each pair timed in both narrations, and the meaningful words inside a pair linked to each other.
Design board: "Two Languages.dc.html" in the Libratory iOS project on claude.ai/design (live
prototype 1a, landscape 1b, hold-a-word 1c, Aa sheet 1d, the translation contract 1e, open
questions 1f). The mode is to be tried in this app's web reader before the iOS app.

**Implementation direction (2026-09-28):** [Practical delivery plan](../docs/two-languages-implementation-plan.md).
First milestone: one real chapter through preparation, bilingual text reading and offline EPUB
export. The [supplied desktop design](../docs/design/bilingual-reader/README.md) is a reference;
paragraph-sliced PDF pairing is deferred. The chapter modal gets a contextual reader link, not an
embedded second reader. The [original brief](../docs/two-languages-design-brief.md) remains background.

**Resume here:** [Reviewed branch handoff](../docs/bilingual-reader-review-handoff.md), on
`feat/bilingual-reader`. User trial and round 2 review are complete; read the current checkpoint
and [round 2 response](../docs/bilingual-reader-review-round-2-response.md), not the older trial-first
instructions. Word-only clipping remains removed; keep continuous click-to-listen.

**Independent review:** `docs/bilingual-reader-review-round-2.md` has been read and preserved.
Future review prompts must name a new output file and record it here; “review done” means read it.

**User-trial follow-up:** [Legacy MP3 seek audit](../docs/bilingual-reader-seek-audit.md).
The user confirmed the M4A comparison. An explicit per-chapter conversion action now preserves
originals/links and updates active recordings for live reading and future exports. Acoustic checks
verify the media seek fix; sentence interpolation accuracy remains a separate limitation.

**Current order:** finish native import compatibility and its full validation gate; implement native
bilingual presentation within the agreed interface scope; complete whole-book audio acceptance;
expose the workflow through assistant/MCP, including legacy conversion; preserve fixtures and
remove the spike. MCP is required but deferred by the user's explicit choice.
The [plan's status table](../docs/two-languages-implementation-plan.md#current-position-and-next-step)
is the current completion checklist. PDF-plus-translation is a later extension, not a completion gate.
The first long-chapter rendering improvement is implemented and measured in the acceptance report.

**Implementation started:** [First-slice report](../docs/two-languages-implementation-progress.md).
The web reader and EPUB export/import now consume an optional bilingual document. Three saved
examples exercise it without paid calls. Production per-chapter preparation, normal manifest/export
attachment and chapter-modal entry are now implemented and tested with mocked models. Real-data
acceptance now covers chapter lifecycle, selection controls, long-chapter profiling and 69-chapter
text export/navigation. Native bilingual consumption, whole-book audio acceptance, MCP and spike
cleanup remain; this task is not complete. See the handoff for current commands and review limits.

**Conversion review follow-up:** [Dispositions](../docs/bilingual-reader-review-83d4d97-response.md).
One-sided conversion and the disabled-control reason are fixed. Before closing this feature,
track retained MP3/map and seek-copy ownership so explicit audio deletion and re-synthesis clean
up obsolete generated recordings; preserve the current backup promise until that lifecycle exists.

**Completion cleanup:** preserve useful fixtures/tests in the maintained suite and keep research
findings, then remove the spike code, temporary viewers and adapters once production preparation
and export replace them. The [delivery plan](../docs/two-languages-implementation-plan.md#completion-cleanup)
tracks this as a completion step; the finished feature must not depend on local spike artifacts.

**Status (2026-09-27):** spike, then an [independent review](../docs/two-languages-review.md), then
a second spike pass that fixed what the review reproduced and tested its token-ID link prompt. The
architecture held; the first pass's scoring, word locator and timing labels did not. Everything
below is measured on one English–Bulgarian book with agent-authored labels — feasibility, not a quality claim
for other languages or genres.

**Multilingual follow-up:** [English–Hebrew and Bulgarian–German review](../docs/two-languages-multilingual-review.md)
adds two validator fixes (15 tests now), three runs per language pairing, and playable word-timed
recordings. The current ID prompt recovered 19/19 targeted Hebrew checks and 18–19/19 German
checks. These checks are not overall precision. Cartesia's Hebrew times were uniformly spaced;
Bulgarian/German included zero-duration words. The viewer reports these quality limitations.

**Reasoning follow-up:** [Flash reasoning experiment](../docs/two-languages-reasoning-review.md).
An 8192-token cap exhausted all six calls before final links; a user-authorized increase to 81,920
allowed all six to finish. Both pairings recovered 19/19 targeted checks in every run, fixing the
German compound miss. One run also over-grouped adjective/noun phrases and emitted an invalid
line. Latency rose from 2–3 seconds to 50–92 seconds; this is not a clean overall quality win.

## Where things stand

Spike code: `packages/server/spikes/two-languages/` (not typechecked, not production code). Outputs
and a playable viewer: `packages/server/data/tmp/two-languages-spike/` (gitignored). Measured on
three Grimm chapters (book `36f42d65…`): English Kokoro narration, the existing Bulgarian translation
lane on the free `bg-mlx` narrator, plus chapter 27's Bulgarian narrated through Cartesia twice.

### Sentence pairs — align finished texts, report doubt

- `segment.mts`: `Intl.Segmenter` plus two Unicode-class corrections (dash/quote dialogue runs;
  a PDF paragraph break inside a sentence). No per-language lists — one was tried and removed.
- `align.mts`: dynamic programming over BGE-M3 sentence vectors (one embedding per sentence, groups
  as length-weighted sums; embedding every window gave identical pairs, 158/158, at 3× the work).
  The search always completes a path, so **trust is decided afterwards and reported as a status**:
  - a merged sentence that does not raise the pair's similarity is split out as `source-only` /
    `target-only` (a dropped translation);
  - a pair far below the chapter's own median similarity (robust z > 4) is `uncertain`.
- Results: the three real chapters stay 163/163 `matched`. The review's two stress cases now
  come out right — a deleted Bulgarian sentence leaves its English sentence `source-only` instead
  of merging it into a neighbour at 0.755; an unrelated replacement is `uncertain` (0.338 against a
  chapter median around 0.85) instead of being presented as the translation.
- The status rules are heuristics with two constants (`MERGE_GAIN` 0.02, `OUTLIER_Z` 4), checked
  on these chapters and the two stress cases only. They are not a calibrated scorer; the review's
  Vecalign-style normalised costs remain the better-founded option once there is labelled data.
- Approach A (translate with `⟦n⟧` markers) worked — 6/6 blocks valid, +12–19% output tokens — but
  retranslating is not a fallback for an existing lane: it changes the text and invalidates its
  narration. It stays an experiment.

### Timing — every edge says how it was obtained

`timing.mts` reports each pair edge with a method: `provider-word` (the engine's word timestamp),
`chunk-boundary` (a chunk's edge, which includes any silence there), `interpolated` (by non-space
characters between known points inside one located chunk) or `unavailable` (text not matched to the
audio — never interpolated across). A sentence's end is its last word's end, not the chunk silence
after it.

- Cartesia lanes: 34/34 Bulgarian edges `provider-word`; the review's audit now finds 0/34 edges
  off the provider's word times (the first pass had 5/34, up to 320 ms).
- Free narrator: 10 `chunk-boundary`, 24 `interpolated` edges on chapter 27. Hiding Cartesia's
  words and interpolating on that same recording is off by 353–434 ms mean, 650–824 ms p90. That
  measures interpolation on Cartesia's pacing, not on `bg-mlx`'s, which pads its chunks; measuring
  `bg-mlx` needs annotated or force-aligned audio of that recording.

### Word links — token ids, not quotes

The model gets each sentence with its word tokens numbered (`tokens.mts`, `Intl.Segmenter` word
granularity — splits Chinese into words, keeps `don't` whole, splits `arch-shepherds`) and answers
`p12: 2 5 = 2` lines. Ids replace the quote prompt's locating puzzle: no occurrence counting, no
case folding, discontinuous groups and shared tokens are representable. Each line is checked
against its own batch, unknown ids are rejected, every requested pair must answer (`p12: -` is an
explicit empty answer), and unanswered pairs are reported, not retried.

Scored against hand-labelled gold for chapter 27 (`review/gold-ch27.json`: 253 sure relations, 199
of them content words, 310 including acceptable ones; one labeller, not native-reviewed), three runs
per prompt, token-level alignment error rate (0 = perfect):

| Prompt | AER over runs | Precision | Recall (sure / content) | Out tokens | Notes |
| --- | --- | --- | --- | --- | --- |
| Quotes (baseline, four sets of 3) | 0.14–0.28 | 0.74–0.90 | 0.74–0.79 / 0.89–0.92 | ~1,600 | coarse phrase links; locator faults |
| Ids, no format example | 0.03–0.04, one 0.28 | 0.97 | 0.96 / 0.95 | ~2,700 | the 0.28 run answered a batch as `a = b \| c = d` on one line; 6 pairs reported missing |
| Ids, example with a grouped link | 0.27–0.34 | 0.57 | 0.97 / 0.96 | ~2,100 | the example made it lump phrases ("large turbulent → голяма буйна") |
| **Ids, single-word example (current)** | **0.05–0.07** | **0.97** | 0.91 / 0.89 | ~2,600 | no missing or invalid lines |

Input tokens are ~3.3× the quote prompt's (the token tables), output ~1.6×. The ids prompt's
residual "errors" are mostly English subject pronouns linked to the Bulgarian verb that absorbs
them ("he → озърташе") — defensible, and the gold was deliberately not loosened toward the winner.
In these non-reasoning chapter-27 runs, the prompt did not group words; "goose boy → гъсарче"
came back as two links to one word, which highlights the same. Grouped output is still possible,
as the later reasoning experiment showed. Prompt wording moved the error rate from 0.05 to 0.30, so any prompt
change needs this evaluation re-run.

## Proposed shape

Three artifacts, each replaceable without the others:

| Artifact | Depends on | Holds |
| --- | --- | --- |
| Sentence pairs | both text revisions (hashes) | pair ids, half-open ranges, status, score, aligner/model/version |
| Word links | pairs revision + tokenizer version | token tables as persisted, links as token-id sets per side, prompt version, model, raw answers, unanswered pairs |
| Pair timing | not stored | derived at read time from each lane's sync map, which is already versioned with its audio |

- **Units**: ranges are UTF-16 code units into the stored text — Swift's string indices and
  Python's code points differ, which matters for the iOS app.
- **Invalidation**: a text edit drops that lane's pairs and links; new audio changes only timing. A
  job whose input hashes changed while it ran does not publish. Nothing re-runs on its own.
- **Jobs**: proposed `alignVariant` in the `index` pool (BGE-M3 lives there), explicitly requested
  per chapter initially; `linkWords` in the `translate` pool, opt-in, cost stated first, failed pairs surfaced for
  the user to re-run.
- **Read path**: `/read/chapter/:id/pairs.json?key=` with per-edge timing methods.
- **Web reader**: a two-language mode in `Reader.tsx`; the spike viewer is the behaviour sketch.
- **Export**: a versioned optional two-lane document beside the one-lane read-along, with old-reader
  behaviour tested rather than assumed.

## Open questions and risks

- **BGE-M3 is an optional 4.3 GB download** and alignment needs it. Offer it at the doorway
  (`<ModelBundleNotice>`), or an explicit LLM alignment of the existing sentence ids.
- **Multilingual coverage is limited.** English–Hebrew and Bulgarian–German word links have
  targeted checks, not complete native-reviewed labels. Sentence alignment in those languages and
  unspaced-language behaviour remain unvalidated; token IDs solve addressing, not semantic quality.
- **Forced alignment for Bulgarian**: Qwen3-ForcedAligner's documented languages and WhisperX's
  default mapping exclude it. Whether another suitable aligner exists is open.
- **Status heuristics are uncalibrated** (see above); a labelled chapter with real omissions and
  insertions is the next alignment benchmark.
- **Link quality varies with prompt wording and run to run**; the gold set is one chapter.
- **Portrait split is tight**: the implementation plan adopts stacked passages on narrow screens
  and paired lanes on wider screens. PDF crop alignment needs a separate geometry experiment.

## Running it

From `packages/server`:

```bash
node_modules/.bin/tsx spikes/two-languages/run.mts [--links=ids|quotes] [--paired]
open data/tmp/two-languages-spike/view.html
node_modules/.bin/vitest run --config spikes/two-languages/review/vitest.config.ts   # 15 behaviour tests, offline
node --import tsx spikes/two-languages/review/eval-links.mts 3                      # both prompts vs gold, 3 runs
node --import tsx spikes/two-languages/review/stress.mts                            # deletion + unrelated replacement
node --import tsx spikes/two-languages/review/timing-audit.mts                      # edges vs Cartesia word times
```

Needs Postgres, the BGE-M3 bundle and the book above. Every LLM step is well under a cent per run
on the default model. The Cartesia takes are reused, never regenerated (`cartesia.ts` pins its
model). Spike code keeps non-null assertions and hard-coded chapter ids; rewrite under the repo's
type rules when built.
