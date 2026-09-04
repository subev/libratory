# Libratory — Agent Context

Personal tool that converts PDF books to M4B audiobooks with chapter markers. Runs locally on Apple Silicon Macs and on Linux (CPU or CUDA; the two MLX narrators stay Mac-only and the UI says so). Fully offline after initial model download.

## Product Vision

This is a personal power-user tool, not a polished consumer product. The design priorities are:

**Assembly is a first-class repeatable action, not a terminal state.** The user can assemble an M4B from selected chapters at any time — mid-synthesis, after tweaking voices, after editing text, after excluding garbage chapters. "Done" just means "there's an assembled M4B file," not "nothing more can be done."

**Per-chapter control is central.** Each chapter can be independently:
- Synthesized with a different voice or speed
- Edited (custom text override before synthesis)
- Included or excluded from the final assembly
- Queued or suspended from processing
- Re-synthesized without affecting other chapters

**The user is in control of processing.** No silent retries (maxAttempts=1), no auto-decisions. Jobs fail once and stay failed. The user reviews and decides what to retry. Cancel preserves completed work.

**Offline-first.** All ML models (Kokoro TTS, Marker/Surya) are cached locally. `HF_HUB_OFFLINE=1` is set on all Python subprocesses. The app works without internet after initial model download.

**Visibility into what's happening.** Worker activity logs to both the terminal and the UI. Every subprocess event is captured. The user should never wonder "what is it doing right now?"

**UI layout mirrors the pipeline order.** The book page is a fixed-viewport shell whose numbered tabs
*are* that order: 1 Source files (input) → 2 Chapters (structure and text work) → 3 Outputs (what was
produced), with Notes trailing after them because it is not a stage. Controls live inside the stage
they affect — extraction options belong with source files, not in a generic actions area. The
selection's actions sit in a tray pinned under the chapter table, because a toolbar above a long table
scrolls away from the very selection it acts on. When adding UI, place it by asking "at which pipeline
stage does the user need this?" — and if the honest answer is "none", it belongs in the book menu (⋯)
or a modal, not wedged into a tab.

### Task Tracking

Ideas and planned features live as individual markdown files in `tasks/`. Each file captures the idea, context, and any design notes.

- To propose a new feature or idea, create a new file in `tasks/` (kebab-case, e.g., `tasks/my-feature.md`).
- **After implementing a feature, check `tasks/` for any related task files and delete them.**
- When starting work on a task, read the corresponding file first — it may contain design decisions or constraints.

## Architecture

pnpm monorepo with two packages:

- `packages/server` — Fastify + tRPC + Graphile Worker + Drizzle ORM (port 3034)
- `packages/web` — React 19 + Vite + Tailwind CSS v4 + react-router v7 (port 3033)

Postgres runs in Docker (`docker-compose.yml` at root), mapped to host port **5433** on loopback only (not 5432, to avoid conflicts; not `0.0.0.0`, because the password is the default one). It was briefly bundled instead and that worked; Docker won because the desktop app requires it anyway and one path beats two — `tasks/desktop-app.md` has the findings.

Environment variables are managed via `.env` at the repo root (gitignored), with `.env.example` as template. The server loads env via `dotenv` in `packages/server/src/env.ts`, validated through a Zod schema. All server code imports the typed `env` object — never reads `process.env` directly. Vars: `DATABASE_URL`, `DATA_DIR`, `PORT`, `CONDA_ENV_PATH` (Python env bin dir; default `<repo>/.venv/bin`, created by `scripts/setup.sh`), `POCKET_ENV_PATH` (Pocket TTS Python env bin dir; default `<repo>/.venv-pocket/bin`), `HF_TOKEN` is read by `scripts/setup.sh` directly (setup-time only, for the gated Pocket TTS cloning weights) and is deliberately not in the Zod schema — no server code reads it, optional AI provider keys — `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` — plus optional `LOCAL_LLM_URL`/`LOCAL_LLM_MODEL` (and `LOCAL_LLM_LABEL`/`LOCAL_LLM_CONTEXT_TOKENS`/`LOCAL_LLM_TOOLS`) for a *custom* OpenAI-compatible server — local Ollama and LM Studio servers are auto-discovered with no configuration (cached 30s, per-model tools capability and context length read from the server); each available model is pickable (registry in `lib/llm.ts`, extra entries via `DATA_DIR/llm-models.json`); `DEFAULT_LLM_MODEL` is the Settings choice every no-explicit-pick request resolves to, written by `setDefaultModelKey` and honoured by `defaultModelKey` only while that model is actually available; the home page ⚙️ opens `SettingsModal` (`llmModels.status` + `secrets.list`/`secrets.set` tRPC) which shows detected local servers/models and edits every user-settable key — written to `.env` via `lib/env-file.ts` and applied to the in-memory `env` without restart, never echoed back to the client (only `configured` and the last four characters). `lib/secrets.ts` holds the one table of those keys, LLM providers and the two cloud TTS providers alike; anything missing from it is unreachable in the desktop app, which has no checkout and no file to edit. Which file gets written is `envFilePath` — `LIBRATORY_ENV_FILE` if set (the desktop app passes `config.json`'s `envFile`), else `<repoRoot>/.env`; `updateEnvFile` writes 0600 and renames into place, because in the packaged app that call is what *creates* the file. `HOST` (default `127.0.0.1`) is what the server binds — 0.0.0.0 was a dev-box default that shipped an unauthenticated library to every network the app is opened on, and CORS is gated for the same reason: `lib/cors.ts` reflects loopback origins, plus an Origin matching the request's own `Host` when that Host is an IP literal (the phone-on-the-LAN case; a rebinding page cannot produce a literal, because to make a browser send `Host: attacker.com` the page must come from attacker.com). Names that legitimately front the server — a reverse proxy, an mDNS or tailnet name — are listed in `TRUSTED_HOSTS`. The file-path columns (`books.pdf_path`/`output_path`, `book_files.pdf_path`, `chapters.audio_path`, `chapter_translations.audio_path`, `assemblies`/`documents.output_path`) store paths **relative to `DATA_DIR`** through the `dataPath` custom column type in `schema.ts` — code on either side still sees absolute paths, and a path outside `DATA_DIR` stays absolute and resolves to itself. They were absolute until 0034, which is why renaming this checkout left 2547 rows pointing at a directory that no longer existed and made the container's `/data` unreachable by construction. `MIGRATIONS_DIR` (default `<repo>/packages/server/drizzle`) is where `main.ts` applies pending migrations at boot: a packaged app has no drizzle-kit and nobody to run `pnpm db:migrate`, so without it a fresh install comes up against an empty database. `VIVLIOSTYLE_DIR` (default `<repo>/vivliostyle`) is where the Vivliostyle CLI is installed when the server cannot resolve it from a `node_modules` — which is every packaged build, where `process.execPath` is the compiled binary and `require.resolve` answers `Cannot find module … from '/$bunfs/root/libratory-server'`; `installCli` writes a one-dependency `package.json` there and runs the binary's own bun (`BUN_BE_BUN=1`), and `renderer.status` reports installed only once both the CLI and a browser are present. Also optional: `READALOUD_DROP_DIR` (synced-EPUB drop folder for Storyteller auto-import).

## Type safety — read this before writing code

The compiler and the linter are the cheapest reviewers in this repo, and they are configured to be
strict on purpose. On 2026-08-28 a single day of enabling them found **eleven real bugs** that no
test covered. Every rule below is written because something broke.

**Statuses and kinds are unions, never `string`.** Drizzle's `enum` option already gives you
`"pending" | "extracting" | "synthesizing" | "done" | "failed" | "suspended"` and friends — never
widen one to `string`, and never accept a bare `string` where a union is available. A union is what
makes an unhandled case a compile error instead of a branch nobody wrote.

**Handle unions exhaustively.** In a `switch`, end with a `default` that assigns the value to
`never`, so adding a status to the schema fails the build at every place that has to care:

```ts
default: {
  const unhandled: never = status;
  throw new Error(`unhandled status ${unhandled}`);
}
```

`noFallthroughCasesInSwitch` is on. Ternary chains over a union get no such check — prefer a
`switch` when the branches matter.

**`noUncheckedIndexedAccess` is on: `arr[0]` is `T | undefined`.** Do not reach for `!` to silence
it — that is the flag switched off one site at a time. Use a guard, a default, or hoist the element
into a checked local. Two whole days of this repo's index accesses were audited with **zero** `!`
added, and four pre-existing ones were removed as standing in for real checks. What it caught:
a chapter dereferenced by an index held in state across list changes (99 use sites, a white page
every time), two drag handlers splicing `undefined` back into a list, an unchecked index returned
by an LLM, and an embedding loop that could spin forever writing nothing.

**An empty array is truthy.** `if (!line.xs)` does not mean "has entries". That guard let `xs[-1]`
through and drew a read-along highlight out of `NaN`s.

**Effect dependency arrays are linted and the rules are not decoration.** `exhaustive-deps`,
`set-state-in-effect` and `exhaustive-effect-dependencies` exist here because a dependency array
containing an inline arrow produced a render loop, React error #185 and a white page — and reached
a release. If a rule genuinely does not apply, disable it at that line **with a one-line reason**;
never blanket-disable, and never silence one to make a number go down.

**`unknown` over `any`, type guards over assertions.** `useUnknownInCatchVariables` is on via
`strict`, so narrow errors with `err instanceof Error` rather than casting.

**Three checks must be green before every commit** — CI runs all of them, lint first:

```bash
pnpm lint        # oxlint, under a second for 45k lines
pnpm typecheck   # tsc --noEmit across every package
pnpm test        # 538 unit + integration tests
```

Open work and the reasoning behind the current settings live in
[`tasks/type-safety-and-lint.md`](tasks/type-safety-and-lint.md).

## Colour and reading surfaces — read this before touching a className

### Two tiers, and the boundary is enforced

`packages/web/src/styles.css` is a **palette** and a **mapping**.

- **Palette** (`--pal-*`) is raw colour: literals only, steps rising as the colour darkens. Every
  step carries a contrast contract — 600 is the brand fill because ink on it is 4.93:1, 700 is text
  on cream because that is 5.36:1, 500 is what survives charcoal. Picking a colour is a lookup.
- **Semantic** (`--accent`, `--danger`, `--text-muted`, …) is a pure `var()` mapping into it.

**Components may only use semantic tokens.** `oxlint` fails the build on `bg-(--pal-…)`. If nothing
in the semantic layer fits, add one there — do not reach past it, and never inline a hex.

Two rules the palette exists to enforce, both learned the hard way:

- **`--*-text` is text IN a colour; `--on-*` is text sitting ON it as a fill.** They are not
  interchangeable. `bg-(--warning) text-white` measured 2.53:1.
- **A brand colour is not automatically a text colour.** The tangerine passes at 4.93:1 under ink
  and fails at 3.23:1 as text on cream. That is why `--accent` and `--accent-text` both exist.

### Reading surfaces are not UI surfaces

Chapter text, the read-along transcript and the reflowed text view are **read**, not operated, and
they follow different rules from the rest of the app. The design line is *machinery in sans, library
in serif*.

| | reading | UI |
| --- | --- | --- |
| face | `font-reading` (Source Serif 4) | sans |
| measure | `max-w-prose` (65ch) | whatever the layout needs |
| size | 17px modal / `text-lg` reader | `text-sm` / `text-xs` |
| ground | `--bg-reading` | `--bg-card` / `--bg-subtle` |

**Do not widen the measure.** Before this was fixed the panes ran ~119 characters per line at 15px;
Medium, Instapaper and Safari Reader all land between 65 and 71. A full-width reading pane is the
single most common regression here, because it looks fine in a screenshot and is miserable to read.

`--bg-reading` is a warm, slightly dimmed ground rather than paper white. Sepia measures roughly 25%
lower effective radiance, and it is the one display-mode claim with real evidence behind it. Text
lands at 8.9:1 — deliberately short of pure black on white, which is harsh over long passages.

Three warm-tinted controls sit together in the chapter toolbar and that is not an accident to be
tidied away: **Reset** is `--danger-bg` because it discards edits, and **Edit** is `--warning-bg`
because saving custom text drops the chapter to `mode: "text"` (`reader-doc.ts`) and the read-along
stops following the PDF page. The old blue palette made these look unrelated; a warm one makes them
look like siblings. They are both cautionary, so leave them cautionary.

### Highlighting: read-along is not annotation

The read-along highlight uses the **accent**, not the conventional highlighter yellow, and that is
deliberate: a moving cue is a playhead, not a mark the reader made. Every immersion-reading product
tracks the voice in its own brand colour. Yellow is the convention for *user-created* highlights —
if this app ever grows those, they should be yellow and visibly distinct from the cue.

The chapter modal's text pane is two paints and no more: `--accent`/18 for the chunk in play and
`--accent`/35 for the sentence being spoken. It used `--bg-selected` for the first, which is the
*table-row* selection token — orange at 10% over `--bg-card`. On `--bg-reading`, a warm cream, warm
sat on warm and the band all but vanished. The `--cue-*` tokens are not the fix either: they are
theme-fixed for the white PDF paper below.

The overlay ladder over a PDF page (`CueOverlay`) is one hue at four strengths — linked chunk, seek
ring, active sentence, active word — painted with `mix-blend-multiply`, because pdf.js renders white
paper in **both** themes. Anything drawn on that layer must read against white; theme-varying tokens
do not belong there. The same applies to `LogDock`, which sits on `--bg-terminal` (dark in both
themes) and therefore uses the `--terminal-*` tokens rather than the theme ramp.

## Icons — read this before drawing an SVG

Every icon comes from **`packages/web/src/components/icons.tsx`**, which is the only file allowed to
import `@phosphor-icons/react`. Names are what the app calls the thing (`IconRename`), not what
Phosphor calls it (`PencilSimple`), so the set can be swapped without touching a call site.

```tsx
import { IconDelete } from "./icons.tsx";
<IconDelete className="h-4 w-4 text-(--text-muted)" />
```

**Need one that is not there?** Find it at [phosphoricons.com](https://phosphoricons.com), add one
`Name as IconThing` line to the module, and use it. That is the whole process — the module is a flat
re-export on purpose. Check `/components` first: it renders the full set with a name filter, read off
the module itself, so it cannot drift from what actually exists.

**Two gates enforce this**, because neither a type nor a normal lint rule can see it:

- `oxlint`'s `no-restricted-imports` fails on `@phosphor-icons/react` anywhere but the module.
- `scripts/check-icons.mjs` (in `pnpm lint`) fails on an inline `<svg>`, a unicode glyph, an emoji,
  or an HTML entity used as an icon — and on an export in the module that nothing renders.

Four rules the sweep of 82 hand-rolled icons established:

- **Size with Tailwind classes, never the `size` prop.** `className="h-4 w-4"` overrides Phosphor's
  `1em` default and keeps sizing lintable and consistent with every other box in the app.
- **Weight carries state, colour is free for something else.** Regular is idle, `weight="fill"` is
  active — the playing track, the selected voice. This is why Phosphor was chosen over Lucide, which
  is stroke-only and can only signal active by recolouring.
- **Never `aria-hidden` at the call site.** `IconDefaults` in `main.tsx` sets it for every icon;
  Phosphor sets none of its own. An icon-only button still needs its own `aria-label`.
- **An emoji is not an icon.** It is full-colour OS artwork that ignores the palette and redraws
  itself differently on macOS and Windows — which matters now that the app ships on both. A `✓` is
  not an icon either: it inherits the text font and lands at whatever size and baseline that font
  decides. If you need an arrow in genuine prose (`press ←`), spell it out — comment lines are
  skipped, and there is no per-line escape hatch: one existed, was documented, and was never used.

## Buttons — read this before styling a `<button>`

Every action goes through **`packages/web/src/components/Button.tsx`**.

```tsx
<Button variant="primary" | "secondary" | "danger" | "warning" | "success" | "ghost" | "icon"
        size="sm" | "md"
        soft            // tinted instead of filled
        square          // the variant="icon" box on any skin, for a coloured icon-only button
        to="/books/1"   // in-app route → react-router <Link>
        href="https://" // external or a download → plain <a>
        disabled />     // with to/href, renders a real disabled <button>
```

Four things it centralises that call sites kept getting wrong:

- **A disabled link is a button.** Pass `to`/`href` with `disabled` and it renders a disabled
  `<button>`, because a disabled anchor still navigates. This is what makes "show the action
  disabled, never hide it" cheap enough to actually follow.
- **`to` for in-app routes, `href` for everything else.** `href` renders a plain `<a>` and costs a
  full page reload — an easy thing to get wrong and not notice, since the destination still loads.
- **`variant="icon"` and `square` require `aria-label`** — an icon-only button has no text to name
  it, and the type will not compile without one. `square` exists because a `soft` icon-only button
  used to fall through to the text padding and sat visibly wrong in a row of `variant="icon"` ones.
- **Disabled styling and the focus ring are not yours to write.** `disabled:` states live in the
  component; focus comes from the base `:focus-visible` rule in `styles.css`.

`soft` is the quiet register of a variant: `danger`/`warning`/`success` become a tint rather than a
fill and `primary` becomes accent text with no fill. The type admits `soft` on those four only. Reach
for it when a control must warn rather than shout — the chapter Edit button is `warning soft` because
saving custom text drops the chapter to mode `"text"` and the read-along stops following the page.

**Render a control when the thing it acts on exists; disable it when that thing exists but the action
cannot run.** Play acts on a chapter, and the chapter is there whether or not it has audio — so it
renders, disabled, with a title saying why. Cancel acts on a *running job*: with nothing running there
is no target, so it is not rendered at all, and its appearing is itself the signal that something
started. The question is never "would this be annoying to show" — it is "what does this button act on,
and does that exist right now".

`className` is **additive only** — `w-full`, `ml-auto`, `shrink-0`, `flex-1`. There is no
`tailwind-merge` here, so passing `px-2` against a variant that already sets padding is undefined
behaviour rather than an override. If a call site needs something the variants cannot express, add a
variant; do not fight the one you picked.

`scripts/check-buttons.mjs` (in `pnpm lint`) fails on any `<button>`, `<a>`, `<Link>` or `<NavLink>` carrying a hand-written
skin — a radius, plus padding or a fixed box, plus a fill or a border. A control that is genuinely
not an action opts out with a `button-ok` comment on one of the three lines directly above it. The gate
cannot check that you wrote a reason, so writing one is on you: `PillToggle` (a toggle),
`VoicePicker`'s trigger (a labelled form control skinned to match the input beside it), and selection
rows. Inconvenience is not a reason.

## Spacing — the ladder

Padding, margin and gap come off one ladder. Every rung is a Tailwind step; there is no semantic
`--space-*` tier, deliberately — colour needed one because `--accent` must resolve differently in dark,
and spacing has no second theme, so `p-4` says more than `p-(--space-card)` would.

```
0.5  1  1.5  2  2.5  3  4  6  7  8  12  16  20
```

| rung | px | what it is for |
| --- | --- | --- |
| `0.5`–`1.5` | 2–6 | inside a badge or pill; icon to its label |
| `2` | 8 | the default gap, and dense table rows |
| `2.5` | 10 | the x-padding of a small control (`Button size="sm"`) |
| `3`–`4` | 12–16 | inner and outer padding of a card |
| `6` | 24 | between sections |
| **`7`** | **28** | **reading gutter only.** Reading panes are `max-w-prose` and padding eats into the box, so this value *is* the measure — it was tuned to 67 characters. Do not use it elsewhere, and see "Do not widen the measure" above. |
| `8`–`20` | 32–80 | page gutters, empty states, clearing the fixed player |

The ladder was derived from what the app already used, not invented: these thirteen rungs cover 94% of
962 existing spacing utilities. `5` and `10` sit between rungs and round **down** to `4` and `8`.

`tailwindcss/no-restricted-classes` fails the build on an off-ladder step and on any arbitrary value
(`p-[13px]`). Widths and heights are not spacing and are untouched by the rule.

**`space-y-*` is not a mistake here.** It is the right tool on a plain block parent, and no element in
this app uses it on a real flex or grid container, where `gap` would belong instead. Converting the 47
block-parent uses would mean making 47 containers flex for no gain.

## Surfaces

Two pages are shells: **`components/book/BookShell.tsx`** (header, tabs, one scroll pane, tray, log
dock) and **`components/library/LibraryShell.tsx`** (header, crumb-and-add bar, filter bar, one
pane). Everything is pinned but the pane, and the pane's child owns its own scrolling and its own
tray — the tray has to sit outside the scroller it acts on.

Each publishes its own contract through its own context, from a pure module: `lib/book-layout.ts`
(four steps, ten booleans) and `lib/library-layout.ts` (four steps, five). Both are under test, and
both drive the same `lib/use-layout-state.ts`, which is the part worth sharing — it holds the
*layout* rather than the width and bails when a resize lands inside the same step, because a context
change walks straight past the children-identity bailout that protects the tables reading it. The
frames themselves are a dozen lines of flex column each and are deliberately not generalised; the
tray is, and `components/ActionTray.tsx` takes `compact` as a prop so both surfaces can use it.

The library's own rules, both of which look like oversights until you hit them: **a folder survives a
filter only while its subtree still has a matching book**, which is why `books.list` returns
`filterState` per book and `filterCounts` per folder — the predicate is `lib/book-filter.ts` on the
*server*, because a folder row has to answer for books the client never receives. And **dropping a
PDF anywhere on the library still works** even though the upload zone now lives in a modal: the pane
catches the drop, `captureDrop` (`lib/dnd.ts`) reads both halves synchronously because a
DataTransfer is dead after the first await, and `UploadZone` ingests them a frame later through its
own folder-scanning path.

`Section.tsx` and the `--step-input` / `--step-work` / `--step-output` ramp are **gone**. The stripe
was "the one place colour still encodes a sequence", and the numbered tab chips do that job now — the
sequence is the tab row, so a card carrying a coloured edge would be saying it twice. A produced-file row is `book/ResourceRow.tsx` (tile, title, subtitle, trailing, badge, actions), shared by
assemblies and documents — source files stay a table because they carry a shift-range selection. On an
assembly the tile *is* the transport: a play/pause circle over a hidden `<audio>`, with elapsed, a
scrub and the speed chip in `trailing` once it is playing. A native `<audio controls>` there brought
its own chrome and pushed the row's actions to the far edge.

Two other container roles are already confined to a single component or file and do **not** need
extracting — say so before "consolidating" them:

- **notice** (`px-3 py-2`, an inline message) lives in `DownloadNotice`, `ModelBundleNotice`, `UpdateProgress`
- **panel** (`p-3`, nested inside a modal) appears only inside `SettingsModal`

## The Pipeline

```
PDF Upload → rawExtract (seconds, always) [→ bookNote (optional AI answer → notes)]
           → extract (opt-in, slow) → normalize (per chapter) → synthesize (per chapter) → assemble → M4B with chapters
```

Every upload extracts raw text with `pdftotext` in seconds (stored per file in `book_files.raw_text`); the slow Marker extraction is **opt-in** ("Extract chapters now" checkbox, default off) and can be run later via `books.extractChapters` from the book page. Raw-only files carry `book_files.status = "raw"` and are skipped by the extract worker until flipped to `pending`. Whole-book Ask AI (`books.aiPromptRaw`) and the upload-time AI prompt run against the concatenated raw text; every AI answer is auto-saved to the `notes` table.

**Synthetic books** (`books.kind !== "pdf"`, currently `"digest"` and `"api"`): books with no PDF (`pdfPath`/`filename` null, zero `book_files` rows) whose chapters are AI-generated text. An **api** book is created by an external script through the JSON API (`api-routes.ts` + `lib/api-books.ts`, docs in `docs/synthetic-books-api.md`) — the caller sends finished chapter text; `cleanText` is computed inline at insert (the text is already spoken prose), so `synthesize: true` queues straight to TTS, otherwise chapters arrive suspended. Digest chapters get the same inline normalization. Example consumer: `scripts/hn-top10.mjs` (Hacker News podcast book). A **digest** is created from the home page (select books → Create digest): one `digest` job sequentially summarizes each source book (chapter text preferred, raw text fallback via `lib/book-source-text.ts`), saves each summary as a note on the source book, and inserts one suspended chapter per source with a `chapters.source` back-link (`{kind:"book",bookId,title}` — snapshot; notes appended as chapters use `{kind:"note",noteId}`, future feed chapters use `{kind:"url"}`). Provenance in `books.origin`, run state in `books.digest_job` (progress "3/10", idempotent resume — already-summarized sources are skipped). Everything downstream (normalize/synthesize/translate/transform/cleanup/assemble/export) works on synthetic chapters unchanged; every PDF-assuming path (extract, redetect, retry, structure, propose, applyChapterBoundaries, append-upload) is guarded on `kind !== "pdf"` — keep it that way when adding features.

**Inserted chapters** (any chapter whose `source` jsonb is set — currently notes via `notes.toChapter`, "Add as chapter" on a note) don't derive from extraction output, so the three rebuild flows (retry, redetect, applyChapterBoundaries) must never delete them: they all go through `resetChaptersKeepingInserted` (`lib/insert-chapters.ts`), which keeps source-tagged chapters at the front (index 0..k-1) with audio state reset (their files die with the output dir) while newly detected chapters offset from k. Preserve this invariant in any new flow that bulk-deletes chapters.

### Job Flow (Graphile Worker)

0. **rawExtract** (`workers/raw-extract.ts`, always queued at upload) — `pdftotext` per file with `rawText IS NULL` (idempotent for appends), stores `rawText`/`rawWords`. Soft-fails (log only) on scanned/encrypted PDFs. Chains a **bookNote** job when the upload requested an AI prompt; marks `books.noteJob` failed if no file yielded text.

0b. **bookNote** (`workers/book-note.ts`, translate pool) — Runs the upload-time AI prompt against the whole book's raw text via the picked model, saves the answer as a note, tracks state in `books.note_job` jsonb (queued/running/done/failed, 15-min stale guard).

0c. **digest** (`workers/digest.ts`, translate pool) — Builds a digest book's chapters: sequentially summarizes each source book from `origin.sourceBookIds`, one suspended chapter + source-book note per source; state in `books.digest_job`; re-queue resumes (sources with an existing chapter are skipped).

1. **extract** (`workers/extract.ts`) — Runs `marker_single` (Python subprocess) on the PDF, outputs structured JSON into a subdirectory. Flattens ALL blocks (not just kept types) with page numbers, polygon coordinates, and an `included` flag. **Chapter detection**: if enabled, first attempts LLM TOC-guided detection (`lib/toc-detect.ts`, model from `books.chapterModel`, default when null — finds the printed TOC, selects chapter-start headings by block index); falls back to the numbered-chapter tier (Chapter N / Глава N sequences, ToC listing pages excluded), then the heading-level heuristic (h1 → h2 → fallback word-count split). Stores per-chapter `sourceBlocks` (jsonb) with full block metadata, plus `pageStart`/`pageEnd`. Creates chapter rows in DB. Queues normalize jobs. When the upload asked for auto-synthesis (`skipSynthesis: false` — the unattended "drop a PDF, get an audiobook" path) it also queues a `waitForAll` **assemble** here, so the promised M4B is a visible waiting job rather than something inferred later.

2. **normalize** (`workers/normalize.ts`, per chapter, parallel) — Strips markdown, reference markers, URLs, rejoins hyphenated line breaks. Saves clean text. Queues synthesize job.

3. **synthesize** (`workers/synthesize.ts`, per chapter, 4 concurrent) — Runs `scripts/synthesize.py` (Kokoro TTS with MPS/Metal GPU acceleration). Uses `customText ?? cleanText ?? rawText` fallback chain for input text. Two-step process: G2P + phoneme chunking upfront (for accurate progress), then synthesis loop. Produces WAV at 24kHz, FFmpeg converts to M4A (AAC 64k, 44.1kHz mono — pinned so assemblies can concat without re-encoding). Skips suspended chapters. Writes chunk progress to DB.

4. **assemble** (`workers/assemble.ts`, user-triggered) — FFmpeg stream-copies selected chapter M4As into one M4B with native chapter markers (ffmetadata), generated cover art, and the audiobook media-type atom; legacy MP3 chapters are re-encoded to the pinned AAC shape first. Assembly is an explicit user action: it is queued only by the user ("Assemble selected" / "Assemble when ready") or by the auto-synthesis upload path in step 1. Finishing a synthesis run never queues one on its own — a manual run usually wants a synced EPUB, not an M4B. Each assembly is recorded in the `assemblies` table with metadata (duration, chapter count, summary).

5. **translate / translateTitles** (`workers/translate.ts`, `translate-titles.ts`, translate pool) — Per-chapter LLM generation of a *variant* (model from `params.model`, default when unset) into `chapter_translations` (TS export `chapterVariants`): either a translation (kind `translation`, key = language) or a prompt-driven rewrite (kind `transform`, key = preset id like `eli5` or `custom-<slug>`; the prompt is snapshotted on the row, presets live in `lib/transform-presets.ts`). Chunked via `lib/transform.ts` (`runToken` fencing, `sourceHash` staleness detection; transforms can run whole-chapter via `params.mode`); translateTitles backfills translated chapter titles (translation lanes only — transforms keep the original title). Chunks stream token-by-token: the worker publishes deltas (including the model's hidden reasoning as `thinking` events) through the in-process channel in `lib/translate-live.ts`, relayed to the modal by `GET /translations/:id/stream` SSE; the DB row stays the source of truth, written once per completed chunk. DeepSeek-style thinking mode is OFF by default for variants (`params.thinking`, toggled by the modal's "Reasoning" checkbox and passed to `variants.start`/`createTransform` alongside `params.model`; bulk runs inherit the lane's stored flags; ignored by providers without the toggle) — v4-flash otherwise reasons at high effort on every chunk, several times slower, and ignores `temperature` while thinking.

6. **synthesizeTranslation** (`workers/synthesize-translation.ts`, tts pool) — TTS for a finished variant (audio state on the `chapter_translations` row, per-variant-slug output dir + chunk previews + sync map). Voice/speed resolve from `books.variantVoices[key]`, falling back to the book's; the Synthesize modal on a variant tab edits the lane, not the book. Like the original lane, it never queues an assembly of its own.

7. **assembleDocument** (`workers/assemble-document.ts`, assembly pool) — Renders selected chapters to `pdf` (one HTML document) or `epub` (one HTML file per chapter plus a generated `vivliostyle.config.mjs`, so readers get one spine item per chapter and a real nav document) via Vivliostyle CLI, or builds the `epub-sync` read-along EPUB from chapter audio + sync maps (`lib/readaloud-epub.ts`); records a `documents` row; optionally copies epub-sync output to `READALOUD_DROP_DIR`.

8. **propose / redetect** (`workers/propose.ts`, `redetect.ts`, extraction pool) — LLM chapter-boundary proposals (structure modal) and full chapter re-detection without re-running marker.

9. **sweep** (`workers/sweep.ts`, startup) — Requeues/fails stranded jobs after a server restart (stuck extracting/assembling books, stale cleanup runs).

10. **indexBook / embedChunks** (`workers/index-book.ts`, `embed-chunks.ts`, index pool) — Search-index maintenance: `indexBook` chunks every text unit (book_files raw text with `\f` page mapping, chapter effective text with per-chunk pages from marker `sourceBlocks` when present, done translations) into `book_chunks`, skipping units whose sha256 `sourceHash` is unchanged; then chains `embedChunks`, which batch-embeds `embedding IS NULL` rows through the BGE-M3 singleton (`lib/embeddings.ts`). State in `books.search_index` jsonb (queued/chunking/embedding/done/failed). FTS works as soon as chunking completes; embeddings are a second pass. Queued via `lib/search-index.ts` `queueIndexBook()` (jobKey-deduped) from every text-mutating completion: rawExtract, extract, redetect, cleanup done, translate done, customText save/reset, digest, notes.toChapter.

Workers run in seven pools (`workers/setup.ts`): `tts` (concurrency 2 — MLX contends for the GPU), `raw` (2 — rawExtract, so raw text never queues behind a 30-minute marker run), `extraction` (1 — extract/redetect/propose), `prep` (2 — normalize, milliseconds of regex that must never queue behind a marker or propose run), `assembly` (1 — assemble/assembleDocument, separate so exports never queue behind a long extraction), `translate` (3 — translate/translateTitles/cleanup/bookNote/digest), `index` (1 — indexBook/embedChunks; BGE-M3 contends for the GPU with TTS). All jobs use `maxAttempts: 1` — no silent retries. Assemblies and document exports are deduplicated via graphile `jobKey` (`lib/output-readiness.ts` owns the key format, so repeat requests and the upload path's queued assembly collapse into one job), and queued/running/waiting exports are surfaced by `books.pendingDocumentExports`.

**Deferred outputs** — `assemble` and `assembleDocument` accept `waitForAll`, which the UI sets when chapters are still synthesizing ("When all N finish" in the output-timing switch). The worker's first act is `deferUntilInputsSettle` (`lib/output-readiness.ts`): if any *selected* chapter still has audio in flight (`pending`/`normalizing`/`synthesizing`, or the variant's `audioStatus` in a language view) it re-queues itself under the same jobKey with `runAt: +30s` and returns without touching `books.status`. The queue row is the only deferral state — it survives restarts via `sweep.ts` and the UI reads `run_at > now()` as "waiting". Failed and suspended chapters count as **settled**, otherwise one dead chapter would strand the request forever; `waitingSince` in the payload caps the total wait at 24h. PDF/EPUB in the original view never wait, since chapter text exists from extraction.

### Book Status

Book status during the synthesis phase is **computed from chapter statuses**, not stored. The `computeBookStatus()` function in `routes/books.ts` derives status:

- `extracting` / `assembling` — from stored `books.status` (book-level operations)
- `synthesizing` — any chapter is `pending` / `normalizing` / `synthesizing`
- `done` — all chapters done AND `outputPath` exists
- `failed` — any chapter failed
- `suspended` — all non-done chapters are suspended

### Chapter Statuses

`pending` | `normalizing` | `synthesizing` | `done` | `failed` | `suspended`

Chapters can be individually queued (creates Graphile job) or suspended (no job, won't be processed). Cancel sets non-done chapters to `suspended`, preserving completed audio.

## Key External Tools

| Tool | Purpose | Called from |
|------|---------|------------|
| **Marker** (`marker_single` CLI, `pip install marker-pdf`, pinned in `pyproject.toml` / `uv.lock`) | PDF → structured JSON | `lib/marker.ts` |
| **Kokoro TTS** (`pip install kokoro`) | Text → speech via MPS GPU | `scripts/synthesize.py`, called by `lib/kokoro.ts` |
| **KugelAudio** (`kugelaudio/kugelaudio-0-open` via `pip install mlx-audio`, local 4-bit MLX quant at `~/.cache/libratory-models/kugelaudio-0-open-4bit`) | Multilingual TTS narrator (24 EU languages incl. Bulgarian) | `scripts/synthesize_kugel_tts.py`, called by `lib/tts.ts` |
| **macOS `say`** (system binary; ALL installed system voices exposed as `say:<name-slug>` — discovered via `say -v '?'` in `lib/say-voices.ts`, listed by tRPC `sayVoices.list`, shown as a dynamic picker group; install more in System Settings → Accessibility → Spoken Content) | Free offline TTS in any installed system voice (~25x realtime, supports speed via `-r`) | `scripts/synthesize_say_tts.py`, called by `lib/tts.ts` |
| **FFmpeg** (system binary) | WAV→M4A (AAC), M4B concat + chapters + cover | `lib/ffmpeg.ts` |
| **music-metadata** (npm) | Read M4A/WAV duration | `workers/synthesize.ts`, `lib/sync-map.ts` |
| **pdftotext** (poppler, system binary) | Fast raw text extraction at upload | `lib/pdf-raw-text.ts` |
| **LLM providers** (auto-discovered local Ollama / LM Studio; DeepSeek / OpenAI / Anthropic / Gemini via API keys) | Translation, transforms, cleanup, TOC detection, digests, Ask AI, chat | `lib/llm.ts` |
| **Cartesia API** (`CARTESIA_API_KEY`; voices `cartesia:<uuid>` from the live library via tRPC `cartesiaVoices.list`, "Cartesia" picker tab) | Neural cloud TTS (Sonic 3.5, 44.1kHz, speed 0.6–1.5x); TS-native chunked client, no Python | `lib/cartesia.ts`, dispatched by `lib/tts.ts` |
| **ElevenLabs API** (`ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL`; voices `elevenlabs:<handle>` via tRPC `elevenlabsVoices.list`) | Neural cloud TTS (24kHz pcm — 44.1k needs their Pro tier; speed 0.7–1.2x). **Metered**: the free tier is 10k characters/month, so synthesis preflights `elevenlabsVoices.quota` and refuses before spending if the chapter will not fit. Word timings come from character-level `alignment`, grouped in `charactersToWords` | `lib/elevenlabs.ts`, dispatched by `lib/tts.ts` |
| **Vivliostyle CLI** (npm, spawns a rendering browser) | PDF/EPUB document export | `lib/vivliostyle.ts` |
| **bun** (the compiled server, re-entered as its own CLI via `BUN_BE_BUN=1`) | Runs the JS the packaged app cannot resolve: `scripts/hn-top10.mjs` and the Vivliostyle CLI, plus the `bun install` that puts the latter in `VIVLIOSTYLE_DIR` | `script-run-routes.ts`, `lib/vivliostyle.ts` |
| **zip/unzip** (system binaries) | EPUB packaging for synced exports | `lib/readaloud-epub.ts` |

## Database

**Optional model bundles** (`scripts/models.py`, `lib/model-bundles.ts`, tRPC `models.list`/`models.download`): setup caches only Kokoro; Marker/Surya (5.1 GB), BGE-M3 (4.3 GB) and the Bulgarian narrators (1.2 GB) download at the one doorway each unlocks — the extract button, the chat page, the Bulgarian voice pane — via `<ModelBundleNotice>`. Status is read from Python because surya's cache is a per-OS platformdirs path; that path is computed with `platformdirs` directly rather than importing `surya.settings`, which drags in torch and made the check 6x slower. `.models-missing` at the repo root forces the absent state and bypasses the status cache.

PostgreSQL 17 in Docker. Schema in `packages/server/src/schema.ts`. Migrations in `packages/server/drizzle/`.

Connection string via `DATABASE_URL` env var (required, validated by Zod).

### Tables

**books** — id (uuid), title, kind (`pdf` | `digest` | `api`, default pdf), filename + pdfPath (nullable — null for synthetic books), outputPath, status (`pending` | `extracting` | `synthesizing` | `assembling` | `done` | `failed` | `suspended`), voice, speed, error, forceOcr, llmChapterDetection, chapterDetection, chapterProposal (jsonb), translationLanguage (last active variant key — drives the variant view default), variantVoices (jsonb `VariantVoices` — per-variant-key voice/speed overrides keyed by lane; absent fields fall back to books.voice/speed, set via `variants.setVoice`), skipSynthesis, totalChapters, noteJob (jsonb), origin (jsonb `BookOrigin` — digest or api provenance), digestJob (jsonb `DigestJob`), folderId (FK folders, `set null` on folder delete — book deletion must go through `lib/delete-book.ts` for disk cleanup, so never cascade), profileId (FK profiles, defaults to the fixed default-profile id), createdAt, updatedAt

**folders** — id (uuid), name, parentId (self-FK, cascade — nested folders), profileId (FK profiles), createdAt, updatedAt. Books live in at most one folder (null = home/root). Home shows only root-level folder rows + unfiled books; `/folders/:id` shows a folder's contents. Recursive aggregates (bookCount/active/size) are computed in `books.list`; subtree/ancestor walks via CTE helpers in `lib/folders.ts`. `folders.delete` collects all descendant books first and deletes each via `deleteBook` before removing the folder row. `folders.move` reparents a folder (rejects moves into the folder's own subtree).

**chapters** — id (uuid), bookId (FK, cascade delete), index, title, rawText, cleanText, customText, audioPath, durationMs, progress (text, e.g. "12/48"), status (`pending` | `normalizing` | `synthesizing` | `done` | `failed` | `suspended`), error, selected (boolean, default true), pageStart/pageEnd (1-based), sourceBlocks (jsonb — block metadata with type, text, page, included, level?, polygon?), sourceFileIndex, source (jsonb `ChapterSource` — digest/note back-link; non-null marks an inserted chapter that survives rebuilds), synthesizedWith (jsonb voice/speed snapshot), cleanup (jsonb `ChapterCleanup` run state), createdAt

**book_files** — id (uuid), bookId (FK, cascade delete), index, filename, pdfPath, status (`raw` | `pending` | `extracting` | `done` | `failed`), selected, skipSynthesis, rawText, rawWords, error, createdAt. One row per uploaded PDF; `raw` = pdftotext-only, marker neither queued nor planned.

**chapter_translations** (TS export `chapterVariants`) — id (uuid), chapterId (FK, cascade delete), language (TS property `key` — the variant key: a language name for translations, a preset id or `custom-<slug>` for transforms), kind (`translation` | `transform`), label (display name; null → key), prompt (snapshot of the transform instruction; null for translations), params (jsonb `VariantParams`: temperature, chunked/whole mode), title, text, status (`pending` | `translating` | `done` | `failed` | `suspended`), progress, error, sourceHash (staleness detection), runToken (write fencing), audioPath, audioDurationMs, audioStatus, audioProgress, audioError, synthesizedWith, createdAt, updatedAt. Unique (chapterId, key). First-class per-chapter variants (translations and AI rewrites) — original text always preserved. Physical table/column names predate transforms and are kept to avoid a risky rename.

**assemblies** — id (uuid), bookId (FK, cascade delete), outputPath, durationMs, chapterCount, chapterSummary, chapterIds (json array), createdAt

**documents** — id (uuid), bookId (FK, cascade delete), language (null = original), format (`pdf` | `epub` | `epub-sync`), outputPath, chapterCount, chapterSummary, chapterIds (json array), createdAt. Written by the `assembleDocument` worker: `pdf`/`epub` render text via Vivliostyle CLI (first run downloads a rendering browser into the Vivliostyle cache); `epub-sync` is a read-along EPUB 3 with Media Overlays (audio + SMIL-highlighted text, built by `lib/readaloud-epub.ts` + system `zip`, playable in Storyteller/media-overlay readers). Layout mirrors the IDPF moby-dick sample (flat OEBPS, no `../` in SMIL refs). If `READALOUD_DROP_DIR` env is set, finished exports are also copied there (pointed at `storyteller/data/import`, a Storyteller watch folder → books auto-import). Storyteller treats that folder as one book's staging area and **skips the whole directory** while it holds more than one read-along EPUB, so the copy step first deletes this book's previously staged exports (`<title>_readaloud_*.epub`); without that, a second export deadlocks imports permanently. Storyteller copies accepted books into `data/assets/<title> [id]/` and adds an `ignore` import rule for the staged path, so removing staged files never affects imported books.

**Sync maps** — `ch000.sync.json` next to each chapter/translation audio file: per-chunk `{text, startMs, endMs}`, plus optional per-word timings on v2 maps (`lib/sync-map.ts`; v1 files stay readable). Kokoro reports word timings during synthesis (`chunk-NNN.words.json` beside each chunk WAV); other engines don't, and `lib/cues.ts` turns whatever exists into cues — a sentence per cue where words are known, the whole chunk where they aren't — reporting which through `granularity`. Written by the synthesize workers after the M4A encode; backfilled on demand from chunk WAV durations (`ensureSyncMap`) during `epub-sync` export. Once the WAVs are cleaned, `chapters.get`/`variants.detail` derive chunk previews from the sync map (`syncMapChunkPreviews`) and the chapter modal plays them by seeking the chapter audio (`startMs`/`endMs`) instead of loading per-chunk files. Once the sync map exists, the chunk WAVs are disposable — the map + chapter audio can rebuild read-along exports forever, so the synthesize workers delete the chapter's chunk dir right after writing it (kept only if the map couldn't be built). `scripts/cleanup-chunk-wavs.ts` (`pnpm cleanup:chunks`, `--apply` to delete) sweeps chunk dirs of finished chapters plus orphans from older chapter splits, ensuring sync maps first.

**bookLogs** — id (uuid), bookId (FK, cascade delete), message (text), createdAt

**profiles** — id (uuid), name, createdAt. Lightweight workspaces (no auth): folders and books carry a profileId; list/create/move routes are scoped to the caller's profile via the `x-profile-id` request header, resolved in `trpc.ts` `createContext` (missing/invalid header → fixed `DEFAULT_PROFILE_ID`, which migration 0025 seeds as "Default" and backfills all pre-profile data onto). Book-level routes (`books.get`, chapters, translations, notes, file downloads) stay unscoped by design — profiles are an organizational boundary, not a security one. The default profile cannot be deleted; other profiles only when empty.

**notes** — id (uuid), bookId (FK, cascade delete, **nullable** — null marks a library-chat answer), profileId (FK profiles), prompt, model (`flash` | `pro`), result (markdown), scope (jsonb `NoteScope` — chapter id+title snapshot, `book-raw`, or `library {folderId?, question}`; no FK to chapters so notes survive chapter re-detection), createdAt. Auto-inserted by `chapters.aiPrompt`, `books.aiPromptRaw`, the `bookNote` worker, and `notes.saveLibraryAnswer` via `lib/notes.ts` `saveNote()`. `notes.toChapter` refuses library notes (no book to attach to).

**book_chunks** — id (uuid), bookId (FK, cascade), profileId + folderId (denormalized from books for index-friendly scoping, refreshed on reindex), source (`raw` | `chapter` | `translation`), bookFileId/chapterId/translationId (FKs, cascade — exactly the one matching `source` is set, translations also carry chapterId), language (variant key), seq, text, charStart/charEnd (true offsets into the source-unit text), pageStart/pageEnd (from `\f` form feeds for raw, chapter page range otherwise), sourceHash (sha256 of the unit's full text — unchanged hash skips reindex), tsv (generated `to_tsvector('simple', text)`, GIN-indexed), embedding (`vector(1024)`, BGE-M3, HNSW cosine index, null until the embed pass), createdAt. Requires the pgvector image (`pgvector/pgvector:pg17`); extensions `vector` + `pg_trgm` are created in migration 0026.

When modifying the schema, change `schema.ts` and run `pnpm db:generate` to produce a migration, then `pnpm db:migrate`. Never write migrations manually.

## File Storage

All data lives in `./data/` (gitignored):

```
data/uploads/{bookId}/               Uploaded PDFs
data/tmp/{bookId}/                   Marker output (JSON inside a subdirectory named after the PDF)
                                     plus geometry.json (page/line/character boxes, see docs/read-along.md)
data/output/{bookId}/                Chapter M4As (ch000.m4a, ...; pre-switch books have .mp3), ch000.sync.json sync maps,
                                     timestamped assembly M4Bs and exported PDF/EPUB/readaloud files
data/output/{bookId}/{langSlug}/     Translation audio (per-language chNNN.m4a + sync maps)
data/output/{bookId}/chunks/         Per-chapter chunk WAV previews + chunks.json manifest
                                     (chunks/{variantSlug}/chNNN/ for variants); disposable once
                                     the sync map exists
data/previews/                       Voice preview M4As (global, shared)
data/pocket-voices/{id}.safetensors  Cloned Pocket TTS voice states + {id}.json metadata (global, shared)
```

Path helpers are in `lib/paths.ts`. The `DATA_DIR` env var defaults to `./data`.

**Important**: `data/tmp/{bookId}/` contains the raw Marker JSON with full block-level data including bbox coordinates. This should be preserved (not deleted) for potential re-processing with different settings (e.g., column filtering).

## Server Structure

```
packages/server/src/
  env.ts                Zod-validated environment variables (dotenv + schema)
  main.ts               Fastify entrypoint: file/audio/document download routes, tRPC plugin, static /files/
  upload-routes.ts      POST /upload and /upload/:bookId (multipart) — always queues rawExtract; extract only when fullExtract
  translation-stream-routes.ts  GET /translations/:id/stream — SSE relay of live variant generation deltas
  api-routes.ts         External JSON API (/api/books…) for scripts creating synthetic books/chapters
  script-run-routes.ts  GET /scripts/hn-top10/stream — spawns the HN script, streams output as SSE
  db.ts                 Drizzle postgres connection
  schema.ts             Drizzle table definitions (source of truth for DB schema)
  trpc.ts               tRPC init (router, publicProcedure, x-profile-id context)
  router.ts             Root tRPC router: books, folders, profiles, chapters, bookFiles, variants, notes
  routes/
    books.ts            Library + book lifecycle + digests + exports (see tRPC Routes below)
    chapters.ts         Chapter CRUD, selection, text edits, cleanup, AI prompts, audio deletion
    bookFiles.ts        Source-file selection, re-extract, skip-synthesis, cancel
    variants.ts         Variant runs (translations + transforms, createTransform, presets), per-variant audio synthesis/assembly, audio deletion
    folders.ts          Folder CRUD (profile-scoped), recursive delete
    profiles.ts         Profile (workspace) CRUD
    notes.ts            Per-book notes list/delete
  workers/
    setup.ts            Graphile Worker runner, task wrappers with console logging, five pools
    raw-extract.ts      pdftotext raw text per file (seconds); chains bookNote when requested
    book-note.ts        Upload-time AI prompt against whole-book raw text → note
    digest.ts           Digest book builder: per-source AI summary → suspended chapter + source note
    extract.ts          Marker PDF extraction + chapter detection
    normalize.ts        Text normalization
    synthesize.ts       TTS synthesis (skips suspended, writes progress + sync map)
    synthesize-translation.ts  TTS for finished translations (per-language audio + sync map)
    translate.ts        Per-chapter LLM variant generation (translation or transform)
    translate-titles.ts Backfill translated chapter titles (translation lanes only)
    cleanup.ts          LLM OCR-artifact cleanup (writes customText)
    propose.ts          LLM chapter-boundary proposals (structure modal)
    redetect.ts         Chapter re-detection without re-running marker
    assemble.ts         M4B assembly with chapter markers + cover
    assemble-document.ts PDF/EPUB (Vivliostyle) and epub-sync (readaloud) exports
    sweep.ts            Startup sweep for stranded jobs
  lib/
    log.ts              appendLog() — writes to DB + console
    paths.ts            Data directory path helpers (uploadsDir, tmpDir, outputDir, previewsDir)
    marker.ts           Marker subprocess wrapper + chapter detection logic
    marker-sources.ts   Locate marker output dirs per source file
    llm.ts              Model registry (cloud providers + local OpenAI-compatible) and shared chat client (AI SDK)
    secrets.ts          The one table of user-settable API keys (LLM + cloud TTS) and the .env write path
    toc-detect.ts       LLM TOC-guided chapter detection
    pdf-raw-text.ts     Whole-document pdftotext wrapper
    book-raw-text.ts    Concatenate per-file raw texts for whole-book AI calls
    book-source-text.ts Best-available text per book for digests (chapters, else raw)
    token-estimate.ts   Pessimistic token estimate for context guards
    notes.ts            saveNote() shared by AI prompt paths
    cleanup.ts          LLM chunk prompts for OCR-artifact cleanup
    translate.ts        Translation chunk/title prompts
    transform.ts        Shared variant engine: splitIntoChunks, transformChunk, per-kind strategy, custom-label inference
    transform-presets.ts Rewrite presets (eli5, shorten, summary, enrich) — edit prompts here
    translate-live.ts   In-process pub/sub for live variant streaming (run-fenced sessions)
    api-books.ts        External-API core: create api books, append source-tagged chapters, status
    tts.ts              Voice registry + synthesis dispatch (kokoro / bg-mlx / mms / kugel)
    tts-chunks.ts       TTS text chunking: NARRATOR_CHUNKS packs to 250-320 chars for the fixed-length
                        Bulgarian narrator, SENTENCE_CHUNKS gives everything else a sentence per chunk
    kokoro.ts           Kokoro TTS subprocess wrapper with onProgress callback
    ffmpeg.ts           FFmpeg WAV→M4A encode and M4B concat/chapter helpers
    normalizer.ts       Text cleanup rules for TTS input
    sync-map.ts         Text↔audio timing maps (chNNN.sync.json) from chunk WAV durations + word timings
    cues.ts             Sync map → highlight cues (a sentence where words are known, else the chunk)
    readaloud-epub.ts   EPUB 3 Media Overlays builder for epub-sync exports (flat layout)
    document-html.ts    HTML rendering for Vivliostyle document exports
    vivliostyle.ts      Vivliostyle CLI subprocess wrapper
    chunk-previews.ts   Chunk WAV preview listing + text locating (read-along in the web UI)
    chapter-artifacts.ts  Removal of a chapter's audio/sync artifacts from disk
    page-geometry.ts    Page/line/character boxes via scripts/page_geometry.py; content + column boxes, median body pt
    cue-rects.ts        Cue text → the rectangles it occupies on the page (see docs/read-along.md)
    reader-doc.ts / reader-routes.ts  The read-along documents: /read/book/:id/book.json and
                        /read/chapter/:id/cues.json — all the web reader is allowed to read
    folders.ts          Folder subtree/ancestor recursive CTEs
    delete-book.ts      The only correct way to delete a book (DB row + disk dirs)
    disk-usage.ts       Per-book disk usage measurement with cache
    insert-chapters.ts  Insert suspended chapters (digest + boundary apply); resetChaptersKeepingInserted (rebuilds keep source-tagged chapters)
    extract-registry.ts In-memory registry of running marker subprocesses (for cancel)
```

## Frontend Structure

```
packages/web/src/
  main.tsx              React root, tRPC/QueryClient providers (x-profile-id header), BrowserRouter
  trpc.ts               tRPC React client (imports AppRouter type from server)
  styles.css            Tailwind v4 import + semantic CSS custom properties; light-dark() pairs
                        switched by color-scheme, so a stored preference can pin either theme
  lib/
    voices.ts           Voice list across all TTS engines
    reader-doc.ts       Types + fetchers for the /read documents, cue lookup, crop math, legibility fit
    format.ts           Shared date/duration/size formatters + document format labels
    languages.ts        Translation language list
    ai-presets.ts       AI prompt presets (digest, notes, "Did you know?")
    book-sort.ts        Book list sort keys persisted in localStorage
    profile.ts          Active profile id in localStorage → x-profile-id header
    theme.ts            Appearance preference (auto/light/dark) in localStorage → data-theme on :root
    dnd.ts              Drag-and-drop payloads for book/folder moves
    use-body-scroll-lock.ts  Modal scroll lock hook
  pages/
    Home.tsx            Library shell: header (profile, chat, reader, appearance, settings), crumb +
                        add bar (upload modal, new folder), filter chips + search, book/folder list
    BookDetail.tsx      Per-book orchestration: staged sections (1 Input → 2 Work → 3 Output → danger zone), variant view (translation or rewrite) in ?variant= query param
    Chat.tsx            Library chat: useChat + streaming /chat, folder (?folderId=) / book (?bookId=) scoping, source chips, saved answers
    Components.tsx      /components gallery: every token, primitive and icon on one screen, derived from
                        styles.css and icons.tsx so it cannot drift. Static — renders with the server down
    Reader.tsx          Read-along reader (/books/:id/read): Column/Page/Text views over one timeline,
                        phone width presets + legibility readout, tap-to-seek, rect/layout debug toggles.
                        Lazy-loaded so no other page pays for pdf.js; reads only the /read documents
  components/
    book/               The book page's shell. BookShell.tsx (pinned header/tabs/tray/dock, one scroll
                        pane, useShellLayout width context) + TabPanel (inactive tabs stay mounted and
                        hidden — unmounting ChapterTable clears nine filters and stops playback);
                        StageTabs.tsx, BookHeader.tsx, VariantMenu.tsx, ExportModal.tsx,
                        BookDetailsModal.tsx, ResourceRow.tsx
    library/            The library page's shell. LibraryShell.tsx (pinned header/bar/filters, one
                        pane that is also the PDF drop target, useLibraryLayout width context),
                        LibraryFilters.tsx (chips + search + showing-count), UploadModal.tsx
    BookFilesSection.tsx    Tab 1 body: source-file table, add files, re-extract, extraction settings
    AudioOutputsSection.tsx Tab 3: produced audiobook assemblies (play/download/delete)
    DocumentOutputsSection.tsx Tab 3: exported PDF/EPUB/synced-EPUB documents
    NotesSection.tsx    The Notes tab: saved AI answers (markdown, copy, add as chapter, delete)
    LogDock.tsx         Bottom log bar (a flex child of the shell, not fixed) + full log modal
    EditableTitle.tsx   Click-to-rename book title
    ChapterTable.tsx    Chapter table — quick-filter chips, title search, the rest behind a Filters
                        popover; sticky header over its own scroller (the pinned filter bar is why the
                        table scrolls rather than the tab), range selection, floating audio player
    SynthesizeModal.tsx Voice/speed picker + start button — behind the toolbar's Synthesize action
                        for the selection, and behind every single-chapter re-synthesize (row icon
                        and chapter modal), which is where a chapter's voice is chosen
    ChapterModal.tsx    Chapter detail modal: view tabs — Pages is the book's own scan, offered only
                        while the print still holds this chapter's words (never on a variant); Text is
                        the spoken prose and is always offered; Source is the extracted text, Compare
                        puts the two side by side, Blocks is the extraction diagnostic. Pages/Text
                        used to be one "Read" tab that chose for you, which left a chapter with no
                        clean text reachable only through the Edit box. Also text editing and the
                        per-chapter actions. Every text pane marks the narrated sentence and word
                        (lib/text-cues.ts locates the cues in it)
    ChapterAiModal.tsx  Ask-AI prompt modal per chapter/book (presets, model pick)
    StructureModal.tsx  Heading-outline structure view, manual boundaries, LLM proposals
    VariantModal.tsx    Variant start/progress modal: language + rewrite-preset + custom-prompt targets, live side-by-side view
    DigestModal.tsx     Create-digest modal (prompt presets, text-availability warnings + exclusion)
    FolderPickerModal.tsx Move-to-folder tree picker
    Breadcrumbs.tsx     Droppable folder breadcrumbs
    BookSearchResults.tsx Search results across all folders with folder-path breadcrumbs
    BookList.tsx        Books overview table (activity pills, no-text pill, languages, outputs, size)
                        with polling, per-row Read + overflow, and the library's pinned ActionTray
    ProfileSwitcher.tsx Profile dropdown in the Home header (create/rename/delete)
    ThemeToggle.tsx     Appearance menu in the Home header (auto/light/dark)
    UploadZone.tsx      Drag-and-drop PDF upload; separate-books mode; upload-time AI prompt. Lives
                        inside library/UploadModal.tsx; also ingests a drop the library pane caught
    ActionTray.tsx      Pinned selection summary + verbs + a primary slot, shared by both shells
    BookKindBadge.tsx   digest / api label, so the list and the search results say it the same way
    PdfPreviewModal.tsx Inline source-PDF preview
    reader/             PdfCanvas.tsx (pdf.js page or column crop, rendered near the viewport),
                        CueOverlay.tsx (highlight + debug boxes)
    DiskUsage.tsx       useDiskUsageTotal (labels the book-menu item) + DiskUsageModal (breakdown + chunk cleanup)
    Menu.tsx            The one popover — book menu, variant picker, tray overflow. Its outside-click
                        is swallowed, or dismissing a menu inside a dialog would close the dialog too
    SegmentedControl.tsx  Promoted out of Reader.tsx; "raised" and "accent" skins
    MarkdownBlock.tsx   Markdown renderer for notes/AI answers
    VoicePicker.tsx     Trigger for the voice library modal (labelled field); queries only the engine owning the current selection to resolve its label
    voice-picker/       VoiceLibraryModal.tsx — **language is the primary axis**: the rail lists languages (plus "Your voices" for clones), the pane groups that language's voices by engine, so "what can read my French book" is one click instead of five tabs. Every voice carries `language`/`engine` (set by the mappers in lib/voices.ts; `staticVoices` decorates the literals). Multilingual models (KugelAudio) appear under every language. Within a language the pane groups by **provider** (`providerOfVoice` in lib/voices.ts — finer than `engine`, so KugelAudio and the Bulgarian narrators are named rather than lumped as "other local models") with filter chips: the chip defaults to the provider of the current selection, typing forces "All" so a search can't silently miss behind a filter, and the combined view caps each provider at 6 rows behind "Show all N" because Cartesia alone can contribute 450 voices to one language. PocketLanguageNotice.tsx (download prompt + size), PocketVoiceCloner.tsx (record/upload + consent), VoiceRow.tsx, context.tsx (selection + preview playback), layout.tsx
    SpeedSlider.tsx     Speed range slider (0.5x-2.0x)
    StatusBadge.tsx     Color-coded status badge
    Modal.tsx           Shared dialog shell: sizes, Escape, focus trap + restore, header that names the dialog
    PillToggle.tsx      Shared selected/unselected pill (aria-pressed) — 9 call sites
    Button.tsx          The one action primitive — variants, sizes, and the disabled-link rule; see "Buttons" above
    icons.tsx           The only file importing @phosphor-icons/react; see "Icons" above
```

### Dark Mode

Both themes come from the same semantic tokens in `styles.css` — components never carry a `dark:`
variant whose only job is a colour. A token that differs between themes is one `light-dark()` pair,
so there is no second block to keep in sync; which half applies is decided by `color-scheme` on
`:root`. See **Colour and reading surfaces** above for the palette/semantic split and what enforces it.

Appearance is a user preference, not just an OS one: `lib/theme.ts` stores `auto` / `light` / `dark`
under the `theme` localStorage key. `auto` leaves `:root` with **no** `data-theme` attribute — that
is what lets `color-scheme: light dark` keep following the OS — and the other two set it, which is
why a pinned theme wins over the OS query where the old media block could not. Pinning also corrects
native scrollbars and form controls, which a token swap alone never reached.

The attribute is stamped **before first paint** by an inline `<script>` in `packages/web/index.html`:
the app's module script is deferred and sits behind a 1.4 MB bundle, so applying the preference from
`main.tsx` would flash the OS ramp on every launch. That copy and `lib/theme.ts` share the `theme`
key by hand; change it in both or neither.

Accents are tokenised like everything else (`--accent`, `--danger`, `--success`, `--warning`, each
with its `-text`, `-hover` and `--on-*` partners), and the log dock is on `--bg-terminal`, not a
fixed zinc.

## tRPC Routes

**books** (library): `list` ({folders, books} for one folder, profile-scoped, activity/failure/size stats + recursive folder rollups + hasText/hasPages flags + per-book `filterState` and per-folder subtree `filterCounts`) · `search` (title words across all folders, returns folder paths) · `textAvailability` (which books have chapters or raw text — digest precheck) · `get` · `logs` / `clearLogs` · `rename` · `updateSettings` · `moveToFolder` · `delete` / `deleteMany` · `diskUsage` / `cleanupChunks`

**books** (pipeline): `upload` (legacy tRPC path) · `retry` · `extractChapters` · `processSelected` · `cancel` · `assemble` · `assemblies` / `deleteAssembly` · `structure` / `proposeChapters` / `applyChapterBoundaries` / `redetectChapters` · `chapterList` · `rawTextStats` (Ask AI itself moved to the streaming `POST /chat/ask` route)

**books** (synthetic + exports): `createDigest` / `resumeDigest` · `exportDocument` (pdf | epub | epub-sync, optional `copyToDropDir`) · `exportConfig` (exposes the configured drop dir for the UI checkbox) · `pendingDocumentExports` · `documents` / `deleteDocument`

**chapters**: `get` · `queue` / `suspend` · `setSelected` / `setSelectedBatch` / `setAllSelected` · `rename` · `reorder` · `updateText` / `resetText` · `queueCleanup` / `stopCleanup` / `cleanupSelected` · `textStats` · `selectedAudioSize` / `deleteAudioSelected` · `deleteSelected`

**bookFiles**: `setSelected` / `setSelectedBatch` / `setAllSelected` · `setSkipSynthesis` · `remove` · `reExtract` / `reExtractSelected` · `cancel`

**variants**: `presets` · `get` / `detail` / `listForBook` / `list` · `start` / `createTransform` / `stop` / `processSelected` · `translateMissingTitles` · `queueAudio` / `processSelectedAudio` / `stopAudio` · `selectedAudioSize` / `deleteAudioSelected` · `assemble` — all keyed by `key` (variant key), not `language`

**folders**: `list` / `create` / `rename` / `move` / `path` / `deleteStats` / `delete` — profile-scoped; `move` rejects subtree cycles; `delete` is recursive (books via `deleteBook`)

**profiles**: `list` (marks the default) / `create` / `rename` / `delete` (refuses default and non-empty profiles)

**notes**: `list` (per book, newest first) / `delete` / `toChapter` (append the note as a suspended chapter, `source {kind:"note"}`; refuses library notes) / `saveLibraryAnswer` (persist a library-chat answer as a book-less note, profile-scoped)

**search**: `library` (hybrid FTS + vector search over `book_chunks`, profile-scoped, optional folder subtree scope, RRF fusion + cross-language grouping — see Library Chat below) / `indexStatus` (per-profile index coverage counts for the chat UI hint)

## HTTP Endpoints (non-tRPC)

- `POST /upload` — Multipart file upload (PDFs + settings fields; `x-profile-id` header assigns the profile). Creates book + book_files rows, queues rawExtract (+ extract when fullExtract).
- `POST /upload/:bookId` — Append PDFs to an existing book
- `GET /pdf/:fileId` — Serve a source PDF (inline preview)
- `GET /download/:bookId` — Serve final assembled audiobook
- `GET /download/assembly/:assemblyId` — Serve a specific assembly
- `GET /download/document/:documentId` — Serve an exported PDF/EPUB/synced-EPUB document
- `GET /audio/chapter/:chapterId` — Serve individual chapter audio
- `GET /audio/translation/:translationId` — Serve translated chapter audio
- `GET /audio/assembly/:assemblyId` — Stream an assembly
- `GET /preview/:voiceId` — Voice preview M4A (generated on demand, cached in data/previews)
- `GET /files/*` — Static mount of the whole output dir (chunk WAV previews, direct file access)
- `POST /api/books` / `POST /api/books/:bookId/chapters` / `GET /api/books/:bookId` — External JSON API for scripts and other projects (`api-routes.ts` + `lib/api-books.ts`, full reference in `docs/synthetic-books-api.md`): create synthetic `kind:"api"` books, append source-tagged chapters to any book (rebuild-safe), poll synthesis status. Optional `synthesize: true` queues TTS per chapter (text is normalized inline at insert); optional `x-profile-id` scopes like the web app.
- `GET /scripts/hn-top10/stream` — Runs `scripts/hn-top10.mjs` as a subprocess and streams its output as SSE (`script-run-routes.ts`); backs the "HN digest" button/modal on the home page. Validated query params (date/count/synthesize/folder/profile), single-flight lock, child survives client disconnect.
- `GET /translations/:translationId/stream` — SSE live feed for a running variant generation (`translation-stream-routes.ts`): snapshot on connect, then `delta`/`thinking`/`status` events from the worker's in-process channel (`lib/translate-live.ts`). The modal's 1s polling stays as fallback.
- `POST /chat` — Library-chat streaming endpoint (`chat-routes.ts`). Raw Fastify route because tRPC can't stream; AI SDK UI-message stream over `reply.hijack()` + `pipeUIMessageStreamToResponse`. Profile via `x-profile-id`. Scope accepts `folderId` (subtree) or `bookId` (single-book chat).
- `POST /chat/ask` — Streaming Ask AI (`chat-routes.ts` + `lib/ask-ai.ts`): whole scope (book raw text or selected chapters) stuffed in context, no tools; same 1M token guard and auto-save-note behavior as the retired sync mutations (`books.aiPromptRaw` / `chapters.aiPrompt`); emits a `data-note` part with the saved noteId. Consumed by `ChapterAiModal` via `useChat` (one "Ask AI" button, scope switcher inside the modal).

## Desktop app (`packages/desktop`)

Electron, and deliberately thin — the app is a local server and a page, so the shell starts child
processes and opens a window. Everything with logic in it is plain Node with tests, because a
display is not available in CI. `tasks/desktop-app.md` has the reasoning, `packages/desktop/README.md`
the state.

- **`src/docker.ts` / `src/launch.ts`** — tested. Docker is found by probing install and socket
  locations for Docker Desktop, OrbStack, Colima and Rancher, **never by `$PATH`**: a Finder-launched
  app gets `/usr/bin:/bin:/usr/sbin:/sbin`, so `which docker` reports nothing on a machine running it.
- **`src/main.cjs` / `src/setup.cjs`** — the window and the first run. Stages `scripts/`,
  `pyproject.toml` and `uv.lock` out of the bundle into `~/Library/Application Support/Libratory`,
  fetches a checksummed `uv`, builds the Python environment from the lockfile, fetches Kokoro,
  brings up Postgres in Docker, applies the migrations, starts the compiled server. ~2.4 GB
  downloaded once, then the window loads it. Steps are a list in `main.cjs` sent to `first-run.html`
  so the window draws itself; the runner blocks the step that failed and marks the rest skipped.
  `runtime.cjs` compares the bundle's `uv.lock` hash against `runtime-state.json` and skips whatever
  is already current — a launch with nothing to bring forward is ~1s. `updater.cjs` checks GitHub
  Releases *after* the window is up. `crash.cjs` turns an uncaught exception into a `crash.log` line
  and a prefilled GitHub issue. Versions are `v<YY>.<MMDD>.<n>` — `v26.826.0` is the first release on 26 Aug 2026, `v26.826.1` the
  second that day. Three numeric parts with no leading zeros, because electron-updater parses both
  sides with semver and `isUpdateAvailable` is private; a 4th part is invalid and a `-2` suffix is a
  prerelease that sorts *below* the release it follows. Update checks run once at launch and every
  6h after — nothing is pushed, each check is a GET of `latest-mac.yml`.
- **One port.** The server serves the built web bundle (`WEB_DIR`, with an SPA fallback) when one
  exists, so a package needs no Vite. In the repo, unbuilt, nothing changes. `lib/spa-fallback.ts`
  holds the fallback as an **allow-list** of the routes `packages/web/src/main.tsx` owns — add a
  client route there too. It reads the other way round on purpose: the rule used to be "a GET with
  no extension is a client route", and `/pdf/:id` and `/audio/chapter/:id` have none, so a missing
  file came back as `index.html` with a 200 and drew every page of every book blank.
- **`scripts/bundle-tools.py`** — copies ffmpeg, pdftotext and pdfinfo out of Homebrew with their
  dylib closure, rewrites load commands to `@loader_path`, and **re-signs ad-hoc**, without which
  Apple Silicon kills them silently. `scripts/make-icon.sh` builds the `.icns`.
- **`scripts/vm-verify.sh`** — run inside a fresh macOS VM (tart), asserts the absences first.
- Updating the runtime, not just the shell, is planned in `tasks/desktop-updates.md` and not built.

## Storyteller Companion (read-along on iPhone)

`storyteller/docker-compose.yml` runs a self-hosted [Storyteller](https://storyteller-platform.dev/) server on port 8001 (secret key + admin credentials + library data in `storyteller/`, all gitignored). Its `/data/import` watch folder auto-imports synced EPUBs within seconds; `READALOUD_DROP_DIR` in `.env` points Libratory's epub-sync exports there (behind the "Copy to Storyteller import folder" checkbox, default off). The free Storyteller Reader iOS app connects to the server over the phone-hotspot tether (`http://172.20.10.2:8001` when the Mac tethers via USB), downloads books, and plays them offline with read-along highlighting. Storyteller iOS builds ≤2.11.3 crash on readalouds whose last spine item has a media overlay; that's fixed upstream (our MR !616), so the exporter no longer appends the trailing colophon page it once used as a workaround — if downloads start crashing, update the app.

## Library Chat & Search Index

**Full deep-dive: [docs/library-search.md](docs/library-search.md)** — chunking, FTS config rationale, embeddings runner, RRF/grouping, citation verification, indexing lifecycle + invalidation table, crash recovery, operations/troubleshooting. The section below is the summary.

Agentic RAG over the whole library (`/chat` page): the picked model iteratively calls search tools over an indexed copy of every book's text, streams a cited answer, and each citation opens the source (PDF page / chapter / translation view). Scope: whole profile, a folder subtree, or a single book ("💬 Chat" on BookDetail → `/chat?bookId=…`). The transcript is ephemeral — it lives in `useChat` state and is gone on refresh ("New chat" also clears it); anything worth keeping is saved explicitly (`notes.saveLibraryAnswer`, `bookId NULL`) and listed in the page's "Saved answers" section via `notes.listLibrary`. This is distinct from **Ask AI** (`POST /chat/ask`) which stuffs the full scope text into context with no retrieval — better for whole-book analysis, no citations.

**Retrieval** (`lib/search.ts`): one SQL statement fuses a Postgres FTS leg (`websearch_to_tsquery('simple', …)`, `ts_rank_cd`) and a pgvector leg (`embedding <=> query`, HNSW, `SET LOCAL hnsw.iterative_scan = 'relaxed_order'`) with reciprocal rank fusion (k=60, top 50 per leg). `groupHits()` then collapses near-duplicates in JS: max 2 passages per source unit, prefers the query's script (Cyrillic heuristic) among close-scoring language twins, drops raw-text hits whose pages duplicate an extracted chapter hit, caps 3 hits per book. Falls back to FTS-only when the embedder is down (`embedQuery` returns null). `expandPassage()` merges adjacent chunks via true char offsets (overlap deduped) for the `read_passage` tool.

**Embeddings** (`lib/embeddings.ts` + `scripts/embed_bge_m3.py`): BGE-M3 (multilingual, 1024-dim normalized dense vectors) as a lazy singleton child process in the Python env — JSON-lines `{id, texts[]} → {id, vectors[][]}` over stdin/stdout, kokoro-style spawn env (`HF_HUB_OFFLINE=1`), restart on crash, idle-kill after 5 min. Batch timeout 5 min, query timeout 20s (chat degrades to keyword search, never blocks).

**Chat loop** (`chat-routes.ts` + `lib/chat-tools.ts` + `lib/citations.ts`): Vercel AI SDK `streamText` with the model resolved from `lib/llm.ts` (any configured provider; models without tool support are rejected for chat), `stopWhen: stepCountIs(8)`, 3-min abort signal, 4096 max output tokens, and a `prepareStep` that forces `toolChoice: "none"` on the last step so the turn always ends with a text answer instead of closing silently after tool calls. Tools: `search_library` (hybrid search, registers hits in a per-request `CitationCatalog` as `c_1…` ids), `read_passage` (neighbor expansion by citation id), `list_books` (titles only). The model must cite `[c_N]` inline; after streaming, `verifySources()` keeps only catalog-known ids (toc-detect discipline — hallucinated ids are dropped) and emits one `data-sources` part the UI renders as chips. The catalog is re-seeded from prior messages' `data-sources` parts so follow-up turns can cite earlier ids. No server-side chat persistence — the transcript lives in `useChat` state; answers are saved via `notes.saveLibraryAnswer`.

**Frontend** (`pages/Chat.tsx`, `components/chat/`): `useChat` + `DefaultChatTransport` against `/chat` (scope + model sent per message in the request body), folder-scope dropdown, model toggle, tool calls rendered as collapsed "Searched: …" lines, `[c_N]` markers rewritten to `[n]` numbering matching the source chips. Chip targets: raw → `PdfPreviewModal` (`/pdf/:fileId#page=N`), chapter with resolvable file+page → same, otherwise `/books/:bookId`; translation/variant → `/books/:bookId?variant=<key>`.

**Indexing lifecycle**: see Job Flow #10. Backfill all existing books with `pnpm backfill:index` (skips `search_index.status === "done"` unless `--force`). Page numbers for raw text rely on `pdftotext` form feeds surviving in `book_files.raw_text` — do not strip `\f` in `lib/pdf-raw-text.ts`. Chapter chunks get per-chunk pages from `chapters.sourceBlocks` (`pageMapFromBlocks`); blockless chapters fall back to the chapter's page range.

## Chapter Detection Logic

Waterfall in `lib/marker.ts` -> `extractPdf()`:

1. **LLM-based detection** (when enabled): LLM TOC-guided selection via `lib/toc-detect.ts` — finds the printed TOC in the first/last pages, then selects chapter-start headings from the heading catalog by block index (selecting ~all candidates is treated as failure). Falls through if the API call fails or returns <2 chapters.

1b. **Numbered-chapter tier**: `pickNumberedChapterIndices()` finds Chapter N / Глава N heading sequences (digits or roman numerals), excludes ToC listing pages (≥3 chapter headings on one page), and keeps the longest increasing run of chapter numbers. Used when it finds ≥3 chapters.

2. **Heading-level heuristic** (fallback via `detectChaptersFromBlocks()`): Picks the highest heading level present (h1 → h2 → h3), splits at those heading boundaries. If no headings found, falls back to splitting every ~5000 words ("Part 1", "Part 2", etc.). If there's substantial text before the first heading (>50 words), it becomes a "Preface" chapter.

Blocks kept: Text, SectionHeader, ListItem, Handwriting.
All others dropped (PageHeader, PageFooter, Footnote, Figure, etc.).

**Important**: Marker nests its output in a subdirectory named after the PDF stem. The code handles this by searching one level deep if the JSON isn't at the top of the output directory.

**Propose (LLM) button** (structure modal) uses a different path: `workers/propose.ts` → `lib/toc-detect.ts` calls the selected model (`books.chapterModel`, per source file): call 1 reads the first/last 15 pages (from marker blocks, so OCR books work) and extracts the printed TOC as JSON; call 2 selects chapter-start headings from a blockIndex-keyed catalog and returns a cleaned title per selection (OCR artifacts fixed, TOC wording preferred), with a corrective retry when far fewer headings than TOC entries were selected. Proposal titles flow through apply: `applyChapterBoundaries` accepts optional per-boundary `title` overrides passed to `sliceChaptersAtIndices`. No `max_tokens` on these calls — deepseek-v4-flash spends budget on reasoning first and a cap can produce an empty response; calls take 1-5 min each (reasoning), timeout 600s.

**Cleanup (AI) button** (chapter modal + "Cleanup selected" toolbar batch): `workers/cleanup.ts` → `lib/cleanup.ts` sends chapter text (`customText ?? cleanText ?? rawText`, chunked via the shared `splitIntoChunks`) to the default model with a strict strip-artifacts-never-paraphrase prompt (temperature 0.3, `allowEmpty` — a 100%-garbage chunk legitimately cleans to nothing). Cleaned chunks accumulate in memory and land in `chapters.customText` in ONE final write so an interrupted run never truncates a chapter. Run state lives in the `chapters.cleanup` jsonb (`status/progress/error/runToken/createdAt/updatedAt`); `runToken` fences duplicate runs, `updatedAt` drives the 15-min stale-running guard. Batch skips chapters whose cleanup status is `done` (manual customText alone does NOT count as cleaned); re-force is per-chapter "Re-clean". Startup sweep requeues stranded pending/cleaning chapters.

## Text Normalization (`lib/normalizer.ts`)

Intentionally minimal — Kokoro handles numbers/dates/abbreviations natively. We only:
- Strip markdown syntax (bold, italic, code, links, images, headers)
- Remove reference markers ([1], [23])
- Remove bare URLs
- Rejoin hyphenated line breaks
- Collapse excess whitespace

## Kokoro TTS Details

- Model: `hexgrad/Kokoro-82M` (82M params, Apache-2.0), cached locally
- Python subprocess: `scripts/synthesize.py` called from `lib/kokoro.ts`
- Two-step synthesis: G2P + `en_tokenize` phoneme chunking upfront (exact chunk count), then `KPipeline.infer()` loop per chunk
- **510 phoneme limit**: Voice pack tensor has 510 entries (indices 0-509). `en_tokenize` can produce chunks >510 chars. `synthesize.py` splits oversized chunks at space boundaries to stay within limits.
- Uses MPS (Metal Performance Shaders) on Apple Silicon; CUDA or CPU elsewhere (torch decides)
- Subprocess timeout: **3 hours** (configurable in `lib/kokoro.ts`)
- Env vars: `PYTORCH_ENABLE_MPS_FALLBACK=1`, `HF_HUB_OFFLINE=1`, Python env path via `CONDA_ENV_PATH`
- Outputs WAV at 24kHz (Kokoro's native rate); FFmpeg resamples to the pinned 44.1kHz mono during the M4A encode so chapters from any engine concat losslessly
- 54 voices across 9 languages. Best: af_heart (A), af_bella (A-), bf_emma (B-)
- Emits JSON progress per chunk to stdout: `{"type": "chunks", "total": N}` then `{"type": "progress", "chunk": 1, "totalChunks": N, "audioSeconds": 3.2}`

## Pocket TTS Details

- Model: `kyutai/pocket-tts` (100M params, CC-BY-4.0), 24kHz output, English model (`english_2026-04`)
- Python subprocess: `scripts/synthesize_pocket_tts.py`, dispatched through `synthesizeChunkedBackend` in `lib/tts.ts` like the other script backends
- **Runs in its own venv** (`.venv-pocket`, pins in `scripts/requirements-pocket.txt`): pocket-tts requires `numpy>=2`, the main env is pinned to `numpy==1.26.4` for marker/kokoro. `synthesizeChunkedBackend` takes a `pythonBin` override for exactly this; every other backend still uses `CONDA_ENV_PATH`.
- **CPU-only by design** — ~12x realtime on 2 cores, so it does not contend with the MLX engines for the GPU and is deliberately outside `runExclusiveMlxSynthesis`
- No speed parameter in the model, so `voiceSupportsSpeed` returns false and the UI disables the slider
- 26 catalog voices in `lib/pocket.ts` carry the per-voice **license** metadata (two are non-commercial — see `docs/tts-licensing.md`); that column is human-researched and can't be derived. The voice **ids** are not duplicated in Python — `synthesize_pocket_tts.py` reads them from the installed package (`_ORIGINS_OF_PREDEFINED_VOICES`) so a `pocket-tts` version bump can't silently desync the two. All resolve under the English model, including the non-English speakers.
- `model.generate_audio(state, text)` defaults to `copy_state=True`, so every chunk re-forks the same voice conditioning — measured drift across chunks is an order of magnitude below the gap between two different voices. This is why it does not have KugelAudio's random-voice-per-chunk problem.
- **Voice ids carry the language**: `pocket:<voice>` is English (the pre-language form, still valid), `pocket:<code>:<voice>` selects a checkpoint (`pocket:it:giovanni`), `pocket:custom:<uuid>` is a clone. `parsePocketVoice` in `lib/pocket.ts` is the single parser; `pocketLanguageArgs` turns it into `--language`. Clones always run on English because their state was encoded against that checkpoint.
- **Language downloads are runtime, not setup-only**: `pocketVoices.downloadLanguage` spawns `--cache-only --language X` with `HF_HUB_OFFLINE=0` — the one path allowed to reach the network — tracked in an in-memory map in `lib/pocket-languages.ts` (lost on restart, like the extract registry). Nothing is cached in the Node process, so a finished download is usable immediately with no restart. `pocketLanguageInstalled` must check **both** HF repos: with `HF_TOKEN` set the weights come from the gated `kyutai/pocket-tts`, without one from the cloning-free mirror.
- Voice cloning takes a reference audio path instead of a catalog name; the weights for it are **gated on HuggingFace** and need `HF_TOKEN` at setup time. The library silently falls back to non-cloning weights when the download 403s — `resolve_voice()` raises an explicit error instead.
- `--cache-only` downloads the model plus all catalog embeddings; `scripts/setup.sh` runs it because synthesis subprocesses set `HF_HUB_OFFLINE=1`
- **Voice cloning**: `POST /upload/pocket-voice` (multipart: `file`, `name`, `consent`) → ffmpeg normalises any container to 24kHz mono int16 WAV → `--export-voice` writes a `.safetensors` state to `data/pocket-voices/`. Voice id is `pocket:custom:<uuid>`; `resolvePocketVoiceArg` (lib/pocket.ts) swaps it for the state path and errors readably if the clone was deleted, mirroring `resolveSayVoice`. Rejected without `consent=true` (Kyutai's terms) or under 8s of audio.
- Re-encoding a reference takes ~0.8s, reloading the exported state ~0.01s — which is why states are stored rather than the source audio
- **Engine capability lives in `web/src/lib/voices.ts`** (`ENGINE_PREFIXES` → `engineForVoiceId`, `voiceSupportsSpeedControl`). Runtime-discovered voices have no static entry, so a new engine MUST be added to that table or it silently defaults to "speed supported" and the UI offers a control the backend ignores.
- **Module split matters**: `lib/pocket.ts` is pure (catalog, predicates, fs probes) and is what `lib/tts.ts` imports; `lib/pocket-voices.ts` holds the ffmpeg/python subprocess work. Keep `child_process` out of `pocket.ts` — the tts dispatch tests mock `node:child_process` with only `spawn`, and a transitive `execFile` import breaks them.

## Marker PDF Extraction Details

- CLI: `marker_single` from `marker-pdf` Python package
- Output: JSON tree (Document -> Pages -> Blocks), written into `{outDir}/{pdfStem}/{pdfStem}.json`
- Each block has `bbox`/`polygon` coordinates (useful for column filtering), `section_hierarchy` for heading ancestry
- `metadata.table_of_contents` may or may not be present (some PDFs don't produce it)
- Uses Surya OCR for scanned PDFs, pdftext for digital PDFs
- Env vars: `TORCH_DEVICE` (mps on a Mac; cuda/cpu by capability probe elsewhere — `lib/marker.ts`), `HF_HUB_OFFLINE=1`
- Timeout: 24 hours (user cancels manually if needed)

## Logging

All worker activity is logged to both:
1. **Database** — `bookLogs` table via `appendLog(bookId, message)` in `lib/log.ts`
2. **Server console** — same `appendLog()` also prints `[book xxxxxxxx] message` to stdout

Worker task wrapper in `setup.ts` logs start/complete/fail with timing:
```
[worker] Starting synthesize (book cc693a45, ch a1b2c3d4)
[worker] Completed synthesize (book cc693a45, ch a1b2c3d4) (45.2s)
```

Workers prefix chapter-specific logs with `[Ch N]` to disambiguate parallel synthesis.

The UI has a LogViewer component that polls `books.logs` every second during processing, with a "Clear" button to wipe logs.

## Development Commands

```bash
pnpm lint             # oxlint over packages, scripts, e2e (also runs first in CI)
pnpm lint:fix         # ...and apply what it can fix itself
pnpm typecheck        # tsc --noEmit across every package
pnpm dev              # Start server (port 3034) + web (port 3033) in parallel
pnpm dev:server       # Server only
pnpm dev:web          # Web only
pnpm db:up            # Start Postgres in Docker (port 5433)
pnpm db:down          # Stop Postgres
pnpm db:generate      # Generate Drizzle migration from schema changes
pnpm db:migrate       # Apply migrations
pnpm run setup        # Full setup (deps check, .venv + pinned Python deps, model caching, Postgres + migrations); bare `pnpm setup` hits pnpm's builtin
pnpm jobs             # Show Graphile Worker queue status (pending/running/failed)
pnpm jobs:clear       # Delete all jobs from the Graphile Worker queue
pnpm backfill:index   # Queue search indexing for all books (skips done; --force redoes)
```

## E2E Suite (`e2e/`)

Playwright suite mirroring the five intro videos' promises (`docs/use-cases.md`); see
`e2e/README.md` for conventions. Runs against an already-running dev server — there is
no Docker path and no webServer autostart.

```bash
pnpm test             # unit tests, both packages — server (vitest + template DB) and web (vitest)
pnpm e2e:smoke        # fast tier (~5s) — while developing / before committing
pnpm e2e:full         # everything incl. @slow (marker, TTS, exports) — before pushing
pnpm e2e:ui           # Playwright UI mode
```

Facts agents get wrong without reading the suite first:

- **`POST /api/books` is the fast chapter factory.** Chapters land instantly (suspended,
  default-selected, synthesizable) — use it for any spec needing chapters instead of
  waiting minutes for marker. Only UC1's extraction specs upload a real PDF.
- **The fake LLM registers at runtime, no restart.** `configModels()` in `lib/llm.ts`
  hot-reloads `DATA_DIR/llm-models.json` on mtime change; the e2e fixture writes stub
  entries there and restores the file. Never reach for `LOCAL_LLM_URL` + restart. The
  stub also scripts one OpenAI tool-calling round so agentic chat runs offline.
- **tRPC speaks plain JSON over HTTP** (no transformer): query via
  `GET /trpc/<proc>?input=<url-encoded JSON>`, mutate via POST with the raw input as
  body, unwrap `{result:{data}}`. Profile scoping is the `x-profile-id` header.
- **Test isolation is profile-per-test** with self-healing: `profiles.delete` refuses a
  non-empty profile, so teardown drains folders (which cascade their books) then root
  books first — `purgeProfile()` in `e2e/tests/helpers/trpc.ts` owns that order, and
  global setup sweeps state left by interrupted runs.

## Gotchas

- Docker Postgres is on port **5433**, not 5432. Another Docker postgres may conflict — check `docker ps`.
- Marker output is nested in a subdirectory. Code in `lib/marker.ts` searches one level deep for the JSON.
- `metadata` field in Marker JSON output is optional — always null-check it.
- **Cancel preserves done chapters** — only sets non-done chapters to `suspended`. Synthesis cancel aborts the TTS subprocess via DB-status polling (SIGKILL). Extraction cancel (`books.cancel`, `bookFiles.cancel`) kills the marker subprocess through the in-memory registry in `lib/extract-registry.ts` — the registry is lost on a dev-server restart, but the extract worker's conditional status updates keep an orphaned marker run from overwriting the cancel.
- **`tsx watch` restarts kill Graphile Worker** but orphan Python subprocesses. In-flight jobs get re-queued on restart. Don't edit server files during long synthesis runs.
- **Graphile Worker jobs use `maxAttempts: 1`** — jobs fail once and stay failed. User retries from the UI. Use `pnpm jobs` to inspect the queue, `pnpm jobs:clear` to nuke stale jobs.
- **Book status is computed** from chapter statuses during synthesis. Only `extracting`, `assembling` come from the stored column. `computeBookStatus()` in `routes/books.ts` derives the rest.
- Python LSP errors on `scripts/synthesize.py` are expected — numpy/kokoro/soundfile are runtime deps in the Python env (`.venv`), not visible to the editor.
- Graphile Worker uses the same Postgres database. Its internal tables (`graphile_worker.*`) are managed automatically.
- **Drizzle text enums are TypeScript-only** — adding new status values (like `suspended`) doesn't require a migration since the DB column is just `text`.
- The frontend polls `books.get` every 2 seconds while processing, stops when status is `done`, `failed`, or `suspended`.
- **`skipSynthesis` is an instruction, not a state.** `workers/extract.ts` reads it once, to decide whether new chapters are born `pending` (and queued for synthesis) or `suspended`. It used to be a per-file table column, which showed a lever that had already been pulled and never said which voice would be used — so the decision now lives with the run that consumes it, in `AfterExtractChoice`, shared by `ExtractModal` and `UploadZone`. `books.setAutoSynthesize` writes it just before the extraction mutation fires; the client awaits that write so it can't race the worker.
- **`forceOcr` / `llmChapterDetection` / `language` are book properties, not app settings** — they describe the source and its text, outlive any single run, and live in `ExtractModal` under "About this book" rather than in the toolbar. The three re-extract buttons collapsed into one scope choice there. **Every scope is destructive** — including "chapter boundaries only", which `workers/redetect.ts` implements by deleting chapters, assemblies, documents and chapter audio — so each one names what it replaces and a tick-box gates the run whenever chapters exist.
- **`books.language` is user-set, never inferred.** An optional ISO-639-1 code driving which voices the picker offers first, chosen from a dropdown built off `TRANSLATION_LANGUAGES` so the two language lists stay in step. An AI detector was built and deliberately removed — it was a lazy shortcut around a one-click field, and the app's rule is that the LLM is an addition, never a dependency.
- **Voice previews speak the voice's own language** (`PREVIEW_TEXT_BY_LANGUAGE` in `lib/tts.ts`). Reading English in a German voice sounds convincing and proves nothing — the same trap as running French text through Pocket's English model. Any new language needs a sentence there.
- **Kokoro's non-English voices take a different G2P path.** `pipeline.g2p()` returns `(phonemes, None)` for espeak-backed languages, and `en_tokenize` is English-only — feeding it that `None` is what silently broke every non-English voice until 2026-08-22. `scripts/synthesize.py` branches on `tokens is None`. Japanese is deliberately absent from the picker (needs a MeCab/fugashi stack + ~700 MB dictionary, and downgrades `wasabi` under spaCy); Mandarin works via the pinned `misaki[zh]` chain.
- **`HF_HUB_OFFLINE=1`** is set on all Python subprocesses. Models must be cached locally before first use. If a model is missing, the subprocess will fail (not download).
- **TTS voice licensing is mixed across engines** — some voices are non-commercial-only. Nothing binds while the project is PolyForm Noncommercial, so no voice is excluded today. Read [docs/tts-licensing.md](docs/tts-licensing.md) before relicensing, charging for hosting, or exposing an engine to paying users.
- **Voice ids are engine-prefixed lowercase slugs** — `say:samantha`, not `say:Samantha`. `parseTtsVoice()` in `lib/tts.ts` validates per engine; the `say` slugs come from `sayVoiceSlug()` lowercasing the macOS voice name.
- **Destructive UI actions confirm via native `confirm()`** (apply chapter boundaries, delete audio, delete folder…), not custom modals. Browser automation dismisses these by default — Playwright needs `page.once("dialog", d => d.accept())` before the click.
- **Document exports are serialized per book** — a second `books.exportDocument` while one renders throws "Assembly already in progress". The UI can no longer walk into it: every format lives in one Export modal behind one CTA, so there is a single disabled state rather than one per button.
- **`books.list` returns `{folders, books}`**, and the root listing hides books that live inside folders — deleting "all a profile's books" via the root list alone misses foldered ones.

## Pending Task Files

See `tasks/` directory. Current tasks:

- `tasks/chapter-merge-split.md` — Merge short chapters or split overly long ones
- `tasks/column-filtering.md` — Filter multi-column PDFs by x-coordinate
- `tasks/per-chapter-voice-speed.md` — Per-chapter voice and speed overrides

### Bulgarian, and why `lang` is load-bearing

Bulgarian Cyrillic is drawn differently from Russian: в, г, д, ж, з, и, к, л, п, т, ц, ш, щ, ю have
their own shapes, closer to upright italic. Source Serif 4 carries them — `cyrl` → `BGR` → `locl`,
26 substitutions — but OpenType only applies them when the text is **marked as Bulgarian**. Without
`lang="bg"` a Bulgarian reader gets Russian letterforms out of the right font, which reads as
foreign. `readingLang()` derives the code from the variant lane (a translation's key *is* its
language) or the book, and every reading surface carries it.

Two traps if you touch the `@font-face` block:

- **Weight descriptors must match across subsets.** A variable Latin face declared `font-weight:
  400 700` beside a static Cyrillic `400` makes Chrome resolve weight before `unicode-range`, pick
  the Latin face, find no Cyrillic glyph, and fall through to Georgia — silently. All four faces are
  static, one per weight per subset, for that reason.
- **Verify with pixels, not widths.** Localised forms keep identical advance widths so text does not
  reflow between languages; a width comparison will report "no difference" while the shapes differ
  completely. And set `<meta charset="utf-8">` in any test harness, or the Cyrillic arrives as
  Latin-1 mojibake and every conclusion drawn from it is wrong.
