# Resolve reading order before narration

User requested a careful comparison before changing the pipeline after seeing
interleaved poetry columns and metadata read before the verse finishes.

## Evidence, 2026-09-17

Private local artifacts: `/private/tmp/libratory-order-comparison/comparison.html`.
The report includes raw outputs and numbered geometry for source pages 49–50
(printed 91–92, reader 83–84) of the Bulgarian test book's third source file.
No paid calls, downloads, or book changes were made for this comparison.

- Saved Flash: song 98 interleaves the two columns within one block. On page 50,
  left-column verse, date and performance note precede the right-column verse.
  This error is already in the transcript and existing audio.
- Saved Tesseract: some native line IDs span both columns. Joining selected words
  by line ID consequently paints across the empty gutter.
- Fresh Surya OCR: accurate separate line boxes, but raw output interleaves columns.
- Surya's dedicated cached layout checkpoint (`layout/2025_09_23`): separates song
  98 and orders song 99's left verse, right verse, then metadata. It still puts the
  date before the right continuation at the top of page 50; song 100 has overlapping
  regions. Raw OCR is not a test of this separate layout model.
- The current cue near 4:53 also contains an isolated match in the attribution.
  Region boundaries need to constrain alignment, not just the final painted bands.

## Next bounded experiment

1. Label intended regions/order manually on these two pages as a reference. Include
   verse, headings, collection date/location, attribution and performance notes.
2. Compare the saved Flash output and Surya layout against one explicitly structured
   model pass on the same two pages. Estimate its API cost and obtain approval first.
   Ask for ordered regions/line IDs and roles, with coverage and duplicate checks.
   Keep geometry measured by local OCR; do not ask the model to invent word boxes.
3. Score column order, verse-before-notes order, page continuation, text coverage,
   and geometry separately. Add a prose control page before choosing a default.
4. Only then decide whether the existing layout stage is sufficient or needs targeted
   model assistance. Avoid another permanent engine ensemble without evidence.

Keep layout region identity through transcription, alignment and highlighting.
Do not merge bands across column/region gaps even when Tesseract supplies one line ID.
Leave uncertain matches unlocated. Correcting narration order changes chapter text
and requires new audio; a geometry refresh alone cannot repair this book's recording.

This comparison changes no production algorithm; implementation is a follow-up.

## Approved three-page prototype, 2026-09-17

Artifacts: `/private/tmp/libratory-region-prototype/comparison.html`, with local
region-timed audio, saved/new transcripts, and `region-text.pdf`. See its README.
Three Flash calls cost less than $0.01 at peak rates. Book and production unchanged.

Raw Surya crops improve song 98's columns and song 99's verse-before-notes order.
Region-constrained alignment keeps those bands out of the gutter. But song 98's
continuation still has the date too early; overlapping regions around songs 100–101
duplicate and truncate transcription. Alignment coverage is 98.1%, 85.8%, and 83.6%
on the two poetry pages and prose control; these are not text-accuracy scores.
This experiment fails acceptance for automatic rollout.

Next: validate/correct layout regions and order before transcription, then recheck
completeness and duplicates on these samples. Retain region identity downstream.
Do not integrate this uncorrected prototype or rebuild the book. Whole-page model
order reasoning remains untested: this prototype transcribed crops in Surya order.

## Manual reference follow-up

`/private/tmp/libratory-region-manual/comparison.html` compares before/after with
local audio and a corrected sample PDF. No API calls or production changes.
Manually corrected page 50's order and overlapping boxes, removed duplicate regions,
split song 100's verse/date/attribution, and restored clipped text from saved
full-page Flash excerpts (plus a clipped verse number). Other pages are controls.
The same alignment code locates about 96.4% instead of 85.8% of transcription units;
no overlapping regions or unassigned native words remain on the corrected page.
Checks cover column boundaries, verse-before-date order, audio playback and PDF text.

This supports region correction upstream but does not validate automatic correction.
It includes explicit text restoration, not merely box edits. Prose remains 83.6%
located. A whole-page model correction experiment is still a separate untested step.

## Whole-page Flash correction test

`/private/tmp/libratory-model-layout/comparison.html`: three approved calls, full
page plus Surya regions and native OCR word IDs, manual reference withheld. Raw
model output and complete prompt retained. No production/book changes.

Fails acceptance. Page 49 retains all words but merges verse columns. Page 50
corrects three verse-before-date cases but drops the four words “и ти носи, Радо,”
from song 100 and merges that song's columns. Prose drops the footnote token
“1950,с.119.” and treats margin OCR noise as a heading. No duplicate/invented IDs.
These are output failures of this particular prompt/configuration, not proof that
all model correction is unworkable. Inter-region ordering scores alone hid omissions.

Three calls used 28,794 input / 4,024 output tokens; about $0.0135 using the prior
conservative peak-rate assumptions. No new PDF or narration from failed output.
Do not integrate. A future separately authorized experiment could ask only for a
small set of region/line edits and validate them locally, instead of making the model
re-emit hundreds of word IDs. Word preservation and separate-column checks are
required before applying proposed edits. Existing prose alignment issues remain.

## Fixed-line ordering experiment

`/private/tmp/libratory-line-order/comparison.html`: three approved Flash calls,
whole page plus immutable Surya line IDs/text/boxes. Every line retained exactly
once (58, 66, 52), no invented IDs or cross-column groups, zero projected reference
order inversions. All four poetry verse-before-date checks pass, including song 100.
Prose lines were generated locally from cached weights; poetry lines reused.

Scope matters: this validates ordering on three pages only. Surya prose input has
bad overlapping detection/recognition, which ordering preserves; Flash reports
uncertainty. Flash also calls performance notes “footer”, so its roles must NOT
control narration inclusion. Flattened order passes, exact paragraph grouping does
not always match. No production, book, PDF or narration changes.

Validation fault-injection checks cover missing/duplicate/invented IDs and column
bridges. Three requests used 12,246 input / 850 output tokens, estimated $0.0047
at prior conservative peak rates. This supports a constrained ordering stage with
separate Flash transcription and fixed geometry, not unrestricted layout rewriting.
Broader representative pages and handling uncertain line detection remain required
before automatic rollout. Role-label semantics must be kept out of inclusion logic.

## Implementation

The constrained path is now opt-in through editable extraction presets; see
[extraction-presets.md](extraction-presets.md). Standard keeps the existing path.
Columns and poetry uses fixed lines and rejects invalid orders; reusable presets
and each book's instruction snapshot are stored separately. Model role labels do
not exclude groups. Broader detection-quality evaluation remains future work.

## End-to-end validation and recovery

The later bounded run used 30 page attempts across ten distinct samples. Explicit
JSON schemas in the prompts fixed responses from providers that accept JSON mode
but do not transmit the SDK schema. Fixed group counts and optional heading levels
removed another contract failure. Removing rough OCR labels from transcription
anchors made the model assign passages to the wrong groups; the labels remain as
orientation hints alongside the image and measured boxes.

The final five poetry runs produced searchable PDFs with 95–98% word placement,
using cached Surya pages in roughly 13–21 seconds per isolated page including local
Tesseract. This excludes the expensive first local Surya pass. Four Standard
controls also completed; the difficult prose page still triggered the existing
low-coverage warning. These diagnostics are not text-accuracy measurements.

The verse-counter instruction worked on four final poetry pages and failed on
source page 35 of `147-281.pdf`. No narration was produced from the samples.
Local review artifacts are under
`packages/server/data/review/extraction-2026-09-17/`; local cleanup now removes the nine residual counters while retaining the raw evidence. The screenshot review also revealed metadata interrupting a verse continuation; this ordering issue remains separate from counter removal.

The interrupted production run's 74 completed local pages (6,304 lines) were
recovered before cancellation and imported into the new durable cache. A real
one-page Surya check confirmed selective page processing and cache-only reuse.
Production remains suspended and its existing chapters/audio are unchanged.

## Semantic groups: seven newly authorized page attempts

The user explicitly approved fewer than ten further attempts. Two known failing
pages plus three other poetry pages and two Standard prose controls completed.
Required semantic kinds and section IDs now separate verse from metadata during
ordering; local validation rejects metadata interrupting verse within a section.
The second call transcribes those fixed groups. Shared local formatting preserves
verse lines while joining printed prose wraps. Standard receives kind instructions
without enabling the ordering stage.

The two known failures now follow left verse, right continuation, then metadata.
Bulgarian Standard output identifies footnotes 14 and 15 automatically; the review
renderer separates them with a rule. Geometry-based cleanup removes 38 counters
across five poetry pages. No sample wording or ordering was manually corrected.
875 tests pass; lint and typecheck pass. Actual results are in
`data/review/extraction-2026-09-17/automatic-structure.html` under packages/server.

Final review: two additional authorized attempts (nine total) verified the explicit
verse continuation contract on both problematic pages. All seven column transitions
are single line breaks; true stanza gaps remain separate. Local page-edge checks
exclude numeric page furniture from narration while retaining source evidence.
Semantic ranges now reach both application reading surfaces, including footnote
separators and word highlighting. Shared joins preserve normalization offsets.
Metadata/prose/footnote kinds cannot undergo counter cleanup.

Wording errors and occasional imperfect classification remain model limitations.
The whole book has not resumed; future trials should stay on selected isolated
pages until the user chooses to process the remaining source.
