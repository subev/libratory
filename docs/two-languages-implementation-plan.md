# Bilingual reading: implementation path

2026-09-28. Engineering decisions after the spike, multilingual experiments and desktop design
handoff. This is the implementation direction; the supplied design is a reference, not a requirement
to build every depicted feature.

## Outcome and boundaries

Prepare a chapter and its translation in Libratory, read either while listening to one narration,
inspect corresponding words, and export the same prepared experience for offline readers. Start in
the web reader. The file contract must support the iPhone reader without requiring a model, server
connection or new narration on the phone.

Use the existing EPUB 3 container with its optional `p2af` layer. Do not introduce another archive
format. Keep ordinary single-language reading and export working.

The next milestone is **one real chapter through preparation, web reading and offline export**.
Model shopping, a redesigned chapter modal and paragraph-sliced PDFs do not block that milestone.
Keep the tested token-ID prompt and reasoning off by default. Existing recordings and fixtures are
enough to begin; no further paid model sweep or voice generation is needed for this step.

## Decisions from the design

The original handoff is preserved unchanged in [design/bilingual-reader](design/bilingual-reader/README.md).
Open [the board](design/bilingual-reader/Bilingual%20Reader.dc.html) with `support.js` beside it.
Its CDN dependencies and simulated PDF are prototype machinery, not application dependencies.

| Design proposal | Implementation decision |
| --- | --- |
| Bilingual toggle, translation picker, separate spoken language | Keep. Reading language and narration are independent choices. Opening the reader never starts processing. |
| Wide paired lanes; narrow stacked passages | Keep, starting with reflowed text. Preserve each language's direction within the existing UI direction. |
| Inspect on word tap, explicit “Listen from here” | Superseded by reader feedback: click/tap listens in that language; hover/focus previews equivalents. Touch can hold or enable meanings-on-tap. Preserve text selection. |
| One player; switching narration preserves play/pause | Keep. Use a valid counterpart anchor; never copy milliseconds between recordings. |
| Chapter modal entry | One contextual “Open bilingual reader” action. Carry chapter, translation and passage; pause the modal player before handing off. No embedded second reader. |
| PDF column slices beside translated paragraphs | Defer until the text path ships and a real-PDF geometry experiment succeeds. |
| Automatically jump to a previous paired sentence when no counterpart exists | Change. Explain the missing counterpart and offer an explicit nearby-passage action. Do not silently move the listener. |
| Optional translation-on-tap layout and custom word navigation shortcuts | Defer. Two responsive layouts and ordinary accessible inspection are sufficient initially. |

The PDF proposal is the largest scope increase. `CuePages.tsx` renders page/column crops and cue
rectangles; these do not establish safe paragraph crop boundaries. The design renders that crop as
live text. Real multi-column pages, paragraphs crossing pages, figures and footnotes need separate
proof. Entering bilingual mode will initially show Text; leaving it can restore the previous view.
The UI must explain that transition rather than imply Column has bilingual support.

The reading surface groups existing sentence mappings at paragraph breaks and presents flowing
text. Pair IDs stay underneath the presentation. Do not add a paragraph-alignment pipeline merely
to reproduce the mockup.
Unpaired text remains visible in reading order.

Use the existing typography, buttons, icons and spacing ladder. Reflowed text uses reading-surface
semantic colours; the theme-fixed `--cue-*` palette stays on white PDF paper. The design's precise
pixel values and proposed components are not a reason to bypass repository conventions or extract
eight new abstractions in advance.

## Data contract before interface polish

Keep `p2af/1` as the ordinary manifest and investigate an optional pointer to a separately versioned
bilingual extension. Older readers must be tested against an actual exported fixture before calling
this backward compatible. Unknown or malformed extension data must not prevent ordinary reading.
The extension's exact field names are to be settled in typed fixtures, not copied from this prose.

The contract needs:

- Stable chapter and lane identities, language tags, exact text revisions and explicit UTF-16
  half-open ranges. Persist the token table; do not retokenize differently on each client.
- Sentence group IDs and statuses, including uncertain and one-sided groups. Word links address
  sets of token IDs and can be discontinuous or many-to-many. An absent link is not proof that a
  word has no translation.
- Independent narration references and recording revisions. Each lane has its own clock. Text
  edits invalidate dependent pairs/links; replacing audio invalidates timing alone.
- Text-to-audio anchors with per-edge provenance and availability. “Provider word” means where a
  time came from, not that someone verified its acoustic accuracy. Preserve measured quality
  limitations separately; do not invent a calibrated confidence score.
- Preparation completeness independent of text and audio availability. A chapter can be readable
  with no voice, paired with no word links, or only partially processed.

Keep raw model answers and job diagnostics on the preparation side, outside the reader payload.
Pair timing can be derived from the versioned sync maps; an exported projection must reference the
same recording and text revisions. Do not create a second authoritative timing store.

Narration switching starts at the matched sentence when available. A word-level landing needs an
unambiguous counterpart and a usable timing anchor; many-to-many links do not provide a unique
word automatically. If the active passage is unpaired or uncertain, leave playback unchanged and
explain the available action. “Sentence counterpart” must not be presented as a word match when
word links are missing. An unavailable voice in the next chapter must not trigger an automatic
language change.

## Delivery order and completion gates

### 1. Contract and one real chapter

Create typed, validated documents and small fixtures from existing spike results. Include English–
Hebrew and Bulgarian–German cases, repeated tokens, a split expression, an uncertain group and a
missing counterpart. These multilingual fixtures test addressing and presentation; they are not
evidence that sentence alignment has been validated in those languages.

Port the required pure code under production type rules. Share builders between served documents
and export. A fixture adapter may help build the vertical slice, but it is not production preparation.

**Gate:** range/token validation, content hash validation, export snapshot binding and narration-anchor
selection have focused tests. Stale database/job publication rejection belongs to phase 3. A sample file documents how another client resolves text, links and audio without a model.

### 2. Reader and offline export together

Extend `DocumentSource` to read the same optional documents from HTTP and EPUB. Add bilingual
text rendering and inspection to the existing reader, retaining one audio element. Follow the active
passage within the reader; the current global cue-follow query must not accidentally choose the
other lane. Manual scrolling suspends follow and offers an explicit return.

Export the second lane's real text, audio and mapping resources, list them in the EPUB package,
and resolve/release their blob URLs on import. Merely adding JSON references is insufficient:
`containerSource` currently registers only primary chapter audio and PDFs, and the exporter writes
one lane. Existing exports also gate read-along layers on cues; text-only bilingual data needs an
explicit path rather than a fake cue or missing resource.

**Gate:** open a newly exported file with the server unavailable; both texts, available narrations,
inspection and voice switching work. Check a narrow Hebrew view, ordinary monolingual import,
missing audio and partial links. Check the existing native reader still opens the primary lane.
Native bilingual consumption follows the proven fixture; it is not implied by web support.

### 3. Real preparation and chapter access

Add explicit per-chapter preparation using existing translation text. Reuse job infrastructure and
existing model selection. Sentence alignment remains a replaceable adapter; BGE-M3 is optional
and its large download requires a deliberate user action. Missing embeddings must not cause
retranslation or an automatic download.

Persist pairs and word links separately. Use bounded batches, visible progress, `maxAttempts=1`,
cancellation that retains completed work, and explicit retry of failed work. Reject truncated model
answers; validate each batch and surface missing/invalid answers. Before publishing, compare the
current inputs with the captured text, pair and tokenizer revisions. Never publish stale results.

Put preparation actions in Chapters and resulting file options in Outputs. Add the modal's reader
link once navigation can preserve its context. Do not introduce a second preparation workflow
inside the reading surface.

**Gate:** the same chapter can be prepared without spike files or hard-coded IDs, exported, edited,
re-prepared and re-narrated with the correct independent invalidation. Failed work stays visible
until the user chooses what to retry.

### 4. Finish the desktop workflow and whole-book use

The first measured rendering fix isolates unchanged sentence passages from playback ticks;
see the before/after acceptance report. Finish reader failure/fallback behavior and keyboard
navigation without thousands of word tab stops, and retain long-chapter checks as work continues.

Close the real per-chapter lifecycle gate: normal UI export/import, text edits followed by
re-pairing, audio replacement without unnecessary re-linking, cancellation and explicit retry.
Support text-only bilingual exports and missing/partial narration without inventing timing.

Apply preparation to a selection with visible chapter progress and explicit costs for paid work.
Load chapter mapping documents on demand. Exercise chapter transitions, cancellation/resume,
mixed readiness and a realistic book-size export before claiming whole-book support. Optimize
alignment, status queries or storage only where measurements justify it.

### 5. iPhone reader consumption

Hand off the proven extension specification and reproducible fixtures, then implement native
bilingual import, rendering, word inspection, independent narration switching and sentence
alternation. Verify actual offline playback, RTL, partial data and ordinary monolingual imports.
The existing Swift decoder check establishes only primary-lane decoding; it is not native
bilingual support. The overall desktop-to-phone feature is not done until this gate passes.

### 6. Assistant and MCP coverage

**Sequencing confirmed by the user:** keep this on the completion list and implement it after the
reader/preparation/export experience is ready. It is not the next slice and no MCP implementation
budget approval is pending. Keep production operations reusable now so this stage exposes the
working workflow rather than creating another pipeline.

A person must be
able to supply a PDF and request the bilingual result through the built-in assistant or an external
MCP client. Both must use the same production operations and persisted jobs as the chapter UI.
Expose preparation status/estimates, local sentence pairing, optional word links, explicit
cancel/retry, both lanes' narration and export. Return usable reader/output locations and concise
progress without sending entire books or mappings back to the agent.

Support two explicit workflows:

- **Local sentence-level:** choose available local translation and TTS providers, use the installed
  local embedding model, and omit word links. Do not silently use a cloud provider or download a
  missing model. If a language has no installed local voice, report the limitation and let the person
  choose text-only for that lane, install a supported local provider, or explicitly authorize cloud
  narration. Timing precision depends on the actual voice; local does not necessarily mean coarse.
- **Word-linked:** add word links with an explicitly selected model and available word-timed
  narrations. Report batch/token estimates and provider choice before paid work. Local LLMs may
  be selected when capable; do not equate word links with a mandatory cloud provider. Word links
  and acoustic word timestamps are independent, so report each lane's actual support honestly.

Reuse upload/extraction, chapter review, translation and export tools. Preserve explicit processing
control and existing assistant approval handling; an overall user request can authorize its stated
steps, but must not imply permission to change provider, download large models or retry failures.
Inspect extracted structure and start with an appropriate sample before a costly book-wide run.
The MCP acceptance gate covers both recipes, missing voices/models, partial preparation and a
failed optional word-link job without losing the readable sentence-level result.

PDF-plus-translation remains a separate extension, not a gate for completing this reflowed bilingual
reader. Evaluate it later with real multi-column and page-spanning examples. Revisit alignment
scoring or prompts when labelled failures justify it; keep model/prompt versions replaceable
without changing the reading contract or regenerating audio.

### Completion cleanup

Once production preparation, reader access and export pass their gates, move useful labelled
fixtures and deterministic regression tests into the maintained test suite. Keep the research
findings as documentation, then remove `packages/server/spikes/two-languages/` and its temporary
viewers and export adapter. Update commands and references so the finished feature has no runtime
or verification dependency on spike files, hard-coded chapter IDs or saved local experiment output.
Remove the completed task file after the implementation and this cleanup are finished.

## Review and verification

Use focused unit and browser checks at each gate; no paid reruns or full E2E suite are needed just
to settle this plan. Model-reported precision and selected recall remain separate measurements.
The existing reviews record the limits of both labels and timestamps.

A second-model review is most useful once the contract, sample EPUB and playback rules are
concrete, before treating the format as stable. It is not a prerequisite for beginning the slice,
and no additional model call has been made for this plan.

## Current position and next step

| Area | Status |
| --- | --- |
| Versioned text/token/link/timing contract | Implemented and validated; native interoperability still needs real playback testing. |
| Web bilingual reader | Working: paragraph flow, click-to-listen, hover meanings, Space, RTL, narration switching and sentence alternation. Measured playback rendering cost reduced; keyboard navigation and failure fallback remain. |
| Per-chapter preparation | Production local pairing and optional model word links, persisted jobs, progress, cancellation, explicit retry and stale-result rejection are implemented. Real long-chapter pairing passed. |
| Offline export/import | Two real chapters exported through production builders and played offline with both recordings; existing word links survived. Normal export-job lifecycle, text-only export and full-book acceptance remain. |
| Whole-book preparation | Selection/scheduling and mixed-readiness acceptance remain. |
| iPhone bilingual reader | Not implemented here. Primary manifest/cue decoding was checked only. |
| Assistant/MCP parity | Queued after the reader workflow, not started. |
| Spike removal | Explicit completion task; preserve fixtures and remove temporary adapter dependencies first. |

**Immediate next step: finish reader keyboard navigation and failure fallback**, then close the
desktop lifecycle and whole-book gates above. Keep checking against
[the real-data baseline](bilingual-reader-acceptance.md). No new model-shopping or prompt sweep
is needed to proceed. See
[the handoff](bilingual-reader-review-handoff.md) for verification details.

Agent-surface audit (2026-09-28): MCP and the built-in assistant already share the MCP registry.
Upload/extraction, translation, primary synthesis and export exist. Missing pieces are bilingual
status/prepare/cancel operations, translated-lane narration controls and per-request translation
model choice (translation currently inherits book settings). `wait_for_book` must not report
bilingual work complete just because primary narration finished. Explicit bilingual reader
navigation should carry the requested translation. Implement these through the existing routes,
with tool-tier classification and end-to-end in-memory MCP tests; do not create another pipeline.
