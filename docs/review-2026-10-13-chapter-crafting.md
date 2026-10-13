# Review: chapter crafting (2026-10-13)

Scope: the chapter crafting view that replaces the structure modal, the preserving apply behind
it, and the dev-port redirect. One commit on top of aec30ae. Reviewed over four rounds: a
self-review in context after each round, a Codex review of the same round in a parallel pane
(briefs and reports under the gitignored `.claude/briefs/`), every finding fixed before the next
round, then a simplify pass and the checks below.

## Change

- `lib/chapter-anchors.ts` — browser-safe helpers: title-like lines, closing marks, locating a
  saved chapter in the current block list, a block's box in the reader's cue-rect space.
- `lib/structure-plan.ts` — pure: what new boundaries do to the saved chapters (kept, new,
  removed), and the decision an edited text override needs when a cut breaks it.
- `lib/structure-apply.ts` — executes a plan: files named by chapter index are staged and
  moved with their chapter, rows change in one transaction, a reported failure rolls the files
  back, removed chapters' files are retired after commit.
- `routes/books.ts` — `structure` returns every block with its box and page size, plus each
  saved chapter's located range; `applyChapterBoundaries` refuses while narration runs, needs a
  decision for a broken edit, keeps outputs on a rename-only apply, re-queues indexing otherwise.
- `components/ChapterCrafting.tsx`, `lib/chapter-craft.ts` — outline, source (real PDF pages
  with cuts drawn on them, or text), a start on any block or page, rename, move, merge,
  explicit front matter, undo/redo, coverage, and folded runs that unfold from either end.
- `lib/spa-fallback.ts`, `main.ts`, `env.ts` — under `pnpm dev` the API port redirects a
  browser to Vite instead of serving a stale `web/dist`.

## Findings

Rounds 1–3 (2026-10-12), all fixed: keep collisions and orphaned keeps refused rather than
dropped; apply refused while a variant narrates; file moves reported and rolled back on
failure; decisions for every removed edit; inserted chapters keep their index; staged rather
than deleted files so a failed transaction loses nothing; PDF document cache ref-counted;
gutter hit boxes scoped to the block; per-page fallback when geometry is partial; page-based
fallback for an edit the extraction no longer holds; closing marks demoted rather than
dismissed; the title's undo checkpoint on the first keystroke.

Round 4 (2026-10-13):

- Saved chapters of a book extracted before marker's whitespace handling changed were not
  located at all (four of five on one book), so the view showed them as gone and apply would
  have re-cut them. Fixed: location ignores whitespace; a chapter is kept when its located
  range equals the fresh cut.
- Codex: a repeated passage located every saved chapter to its first occurrence, collapsing
  two chapters into one and retiring the second's audio. Fixed: chapters are located in index
  order, each after the previous one; preview and apply share the result.
- Codex: a block newly left out or taken in has the same words, so range equality called it
  unchanged while the spoken text differed. Fixed: location compares inclusion too; such a
  chapter is a re-cut.
- Codex: the task note still called the transactional swap unbuilt. Reworded to the real gap,
  crash recovery between staging files and committing rows.
- Own: squeezed block texts cached per block list; a 347-chapter book located its chapters
  in one pass over the blocks.

Open by design, filed in `tasks/preserve-chapters-on-restructure.md`: a restorable previous
structure after apply; crash recovery mid-apply; reveal state keyed by a run's first page
survives only on the prefix when a cut splits the run.

## Verification

- `tsc --noEmit` on the working tree and on an export of the staged tree, `pnpm lint` (no
  errors), server vitest 140 files / 1174 tests, web 31 / 179, desktop 6 / 50.
- e2e: the re-cut test in `uc1-core-loop.spec.ts` against the dev stack.
- Browser, against the dev stack: a saved book with a one-letter title page gets a start from
  the page header with the title focused and one Undo reverts it; Options Procedures locates all
  five saved chapters again (checked on the structure query); Peter Rabbit's folded run opens two pages after and two
  before, then hides.
