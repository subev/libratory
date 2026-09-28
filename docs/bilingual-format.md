# Optional bilingual reader document

Experimental implementation, 2026-09-28. The base manifest remains `p2af/1`. A chapter may add:

```json
"bilingual": [{ "key": "he", "language": "he", "url": "bilingual/he.json" }]
```

The URL names a `p2af-bilingual/1` document. **Every resource URL is relative to `book.json`,
including audio references inside the nested document.** Served documents may use rooted HTTP
paths. EPUB documents use archive-relative paths; secondary audio is stored, not deflated.
Ordinary EPUB content and its primary narration remain in the spine/media overlay.

The executable schema and validation are in
[`bilingual-format.ts`](../packages/server/src/lib/bilingual-format.ts). A small, synthetic
[English–Hebrew fixture](../packages/server/src/lib/fixtures/bilingual.json) demonstrates the wire
shape, including a discontinuous expression. Its timings and recording revision strings are test
values, not real acoustic measurements.

Each document contains a chapter ID, translation key, tokenizer version, two lanes and ordered
sentence groups. Each lane carries its exact text, SHA-256 text revision, persisted token table
and optional narration. Token IDs are unique **within a lane**, not relative to a sentence. Text
ranges are half-open UTF-16 code units with grapheme-aligned edges. Clients must not normalize or retokenize stored text.

Each group has an ID, a status (`matched`, `uncertain`, `source-only`, `target-only`), nullable
ranges in the two lanes, link completeness and word links. Links contain token-ID sets on each
side; groups may be discontinuous, share tokens or represent several words. Missing links do
not prove absence of a translation. Only matched groups may assert links. Whitespace between
group ranges belongs to the stored text; non-whitespace must not silently disappear.

Narration carries a recording revision, audio URL, duration, quality notes and text-to-audio anchors.
The revision is SHA-256 of the packaged recording bytes. Each anchor is a word or
passage range with separate start/end edges. Each edge names its method (`provider-word`,
`chunk-boundary`, `interpolated`, `unavailable`); unavailable edges have a null time. Zero-duration
provider words may be retained as evidence but cannot receive an active-word highlight.

Readers verify text hashes and structural/referential integrity before displaying links. Recording
revisions identify the timing/audio dependency; the reader does not hash entire audio files on
every open. Export checks the source text against the primary cues, requires source narration to
reference the primary audio, and hashes the actual staged recordings before creating the archive.
This binds the exported snapshot; it does not check current database state. Production preparation must capture input revisions and reject stale publication.
An audio replacement must regenerate its anchor projection while preserving text-only mappings.

The current switch policy lands at a matched counterpart passage's start and preserves play/pause.
Missing timing or uncertain/absent pairing blocks the switch with an explanation. Clicking a word
seeks in that language; missing word timing falls back to the passage start with an explanation.
Hover/focus only previews the equivalent. Recordings never share clocks.

An unsupported or malformed extension produces a bilingual error with a way back to ordinary
reading. A missing secondary audio entry degrades to readable text with its voice unavailable.
The document loader registers secondary audio only when needed and releases its blob URLs when
the file closes.

This is a client projection, not the proposed preparation database schema. Raw answers, costs and
job diagnostics do not belong here. The extension should receive a compatibility review before
being treated as a stable native-reader contract.

## Production preparation

`bilingual_preparations` stores the text pairing artifact, independent word-link batches and their
jobs for each completed translation. The current producer is `bge-m3-dp/1`, using persisted
`intl-segmenter-word/1` tokens and the `token-ids/1` word-link prompt. These producer versions are
independent of `p2af-bilingual/1`; changing an algorithm need not change the reading format.

A queued job captures text hashes. Publication checks current text and run identity under row locks;
word links additionally bind to the pairing artifact revision. Text edits make references unavailable
until preparation is repeated. Audio changes preserve the text artifact: live/export builders read
sync maps anew and hash recording bytes. Export checks those hashes again on the staged files.
Cancelled/failed jobs keep completed batches; only an explicit retry continues work. Raw model
answers stay in the database and never enter the reading document.

Original-language synced EPUB exports include current prepared translations for chapters carried
with primary cues. Translation-only exports remain single-lane. Text-only export without primary
cues and book-wide preparation controls are still pending.
