# Cleanup as an editable transform — planned, not built

**Asked for 2026-09-04.** Cleanup today is one hardcoded system prompt in `lib/cleanup.ts`, run by
`workers/cleanup.ts` over `splitIntoChunks`, with no model pick and nothing the reader can change.
It should be a *preset* — a prompt you can edit per book, the way variants already take a custom
prompt — because a whole-chapter transform is the powerful thing here and cleanup is only its
first instance.

## What the run on `Странджа проучвания` showed

One 3.2k-char chapter, DeepSeek V4 Flash: **10m43s**, 3170 → 3112 chars, **85 changed regions**.
The changes were right — `тракит%` → `тракитѣ`, `вжтрешностьта` → `вѫтрешностьта`,
`крайбрЪжието` → `крайбрѣжието`, `УШ и МП` → `VIII и VII`. So the generic prompt does work on
pre-1945 Bulgarian orthography; what it cannot be told is anything book-specific, and at that rate
a 32-chapter book is ~6 hours and a cloud bill.

## What exists to build on

- **Variants** (`lib/transform.ts`, `routes/variants.ts`, `VariantModal`) already run a chunked
  per-chapter LLM pass with a *custom prompt* and a model pick, writing to `chapter_variants`.
- **Cleanup** writes to `chapters.custom_text` and tracks state in the `chapters.cleanup` jsonb
  (`status`, `progress`, `model`), which is a different lane on purpose: it replaces the text the
  rest of the app narrates rather than adding a variant beside it.

## The shape to aim for

1. Cleanup becomes one **preset** among several: a name, a system prompt, and a default model.
2. Presets are editable and savable — at least per book, so this book can say "the letters ѣ ѫ ѭ
   and word-final ъ are correct, never modernize them".
3. The run keeps writing to `custom_text` (that is what makes it cleanup rather than a variant),
   and the preset it ran with is recorded next to `model` in the cleanup jsonb.

## Open questions

- Where presets live: a table, `DATA_DIR/presets.json`, or per-book columns?
- Does a custom preset stay in the cleanup lane, or become a variant that can be promoted?
- Per-chunk context: cleanup is stateless per chunk; an orthography instruction is cheap to repeat,
  but a glossary of this book's recurring OCR confusions would need collecting first.
