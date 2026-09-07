# Stage 2 preamble (shared by the three parallel agents)

Read first: `tasks/ocr-text-layer-implementation.md`, `tasks/ocr-text-layer.md`, `tasks/ocr-text-layer-design-brief.md`,
`tasks/ocr-text-layer-design-review.md`, and `AGENTS.md` in full. Then your own contract. Everything decided there is
decided; do not redesign. Where a mechanic is left to you, copy the shape of the neighbouring code.

## What stage 1 already shipped on `main` (read it before writing a line)

- Schema: `books.ocrEngine: "tesseract" | "surya" | null` (`OCR_ENGINES`, `OcrEngine` exported from `schema.ts`);
  `bookFiles.searchablePdfPath`, `ocrEngine`, `ocrConfidence` (0..1), `ocrLowConfidenceFraction` (0..1).
- `lib/ocr-text-layer.ts`: `ensureTextLayer(...)` — the step; dispatches on engine with an exhaustive switch, writes
  `<stem>.ocr.pdf` beside the original, updates the row and re-derives `rawText`/`rawWords`. `readablePdfPath(file)`
  is what every PDF reader uses. `OcrRunner` / `OcrStats` are the engine contract.
- `lib/ocr-tesseract.ts`: the Tesseract runner (pdftoppm 300 dpi gray → one tesseract run over a page list →
  `pdf tsv` outputs; per-page `OCR page N/total` log lines; abort = SIGKILL; stats from the TSV).
- `lib/tesseract-languages.ts`: ISO-639-1 (`books.language`) → tessdata code + name.
- `workers/ocr-text-layer.ts`: job `ocrTextLayer { bookId, force? }` in the extract pool; abort registry key = bookId.
- `workers/extract.ts` runs `ensureTextLayer` inline before marker for each file when `book.ocrEngine` is set.
- `env.TESSDATA_PREFIX` (optional) is passed to every tesseract subprocess; the desktop launcher sets it to
  `HOME/tessdata`, staged from `resources/tessdata` by `setup.cjs` `stageRuntime`.
- `books.get` returns per file `ocrEngine`, `ocrConfidence`, `ocrLowConfidenceFraction`, `hasSearchablePdf`.
- Web: `UploadZone` and `ExtractModal` carry a tick-box meaning `ocrEngine: "tesseract" | null`.

Run `git log --oneline main -20` and read the stage 1 commits' diffs for the exact names; if a name here differs
from the code, the code wins.

## Isolation — three agents run at once

You are in your own git worktree on your own branch. Do this before anything else:
1. `cp /Users/petur/repos/libratory/.env .env` then edit YOUR copy: set `DATABASE_URL` to the same server with the
   database name given in your contract (the test template and test databases derive their names from it), and
   `PORT` / `WEB_PORT` to the values in your contract. Never touch the main checkout's `.env`.
2. `pnpm install` is already satisfied by the shared store; run it once anyway. The Python env is
   `/Users/petur/repos/libratory/.venv` (`CONDA_ENV_PATH` in .env points at it); do not rebuild it.
3. Your `DATA_DIR` is `./data` inside the worktree — empty, which is fine for proofs. Delete any book you create.

Only one dev server per port: use YOUR ports for any end-to-end proof, kill by PID from `lsof -i :<port>` (never by
name pattern), and shut everything down before you finish. Never run the e2e suite; the orchestrator runs it after merge.

## Shared files — keep edits additive and small

Three branches merge back one after another. `router.ts`, `AGENTS.md`, `README.md`, `styles.css`, `ExtractModal.tsx`,
`UploadZone.tsx`, `SettingsModal.tsx`, `schema.ts` are touched by more than one of you: add a line or a block, never
reflow or reorder what is there. Your contract says which of those you own; do not edit the ones you don't.

## House rules (from the user, non-negotiable)

- Comments: default to NONE. One short line only for non-obvious intent, a tradeoff, an invariant, or a constraint the
  code cannot express. Never narrate what a line does.
- `type` over `interface`; unions never `string`; exhaustive `switch` with a `never` default; no `!` for index access;
  `unknown` over `any`. Effect dependency lint rules are real — never blanket-disable.
- Tests beside the code they test, in the neighbours' shape; never mock Drizzle (worker/route tests use the real test
  database via `test/setup.ts`); no `waitForTimeout` anywhere.
- Icons only through `packages/web/src/components/icons.tsx` (`scripts/check-icons.mjs` rejects anything else);
  colours only through tokens (`scripts/check-tokens.mjs`); buttons per AGENTS.md (`scripts/check-buttons.mjs`).
  `pnpm lint` runs all three.
- Commits: `type(scope): imperative summary`, lowercase, <= 72 chars, scopes from `git log`; body says why and what
  proves it. NEVER add Co-Authored-By / Claude-Session trailers or a "Generated with Claude Code" footer.
- Never restart a job the user cancelled. Never author a migration outside `~/repos/libratory` — you are in a worktree
  of it, so `pnpm db:generate` is fine, but every contract below expects NO schema change; if you believe one is
  needed, stop and say so in your report instead of adding it.
- Do not delete the `tasks/ocr-text-layer*.md` files; the orchestrator does that when everything has merged.
- Done = `pnpm lint`, `pnpm typecheck`, `pnpm test` green in your worktree, plus the proof your contract names.
  Report: what you built (files), what you proved (numbers), what you could not do and why, and anything in the
  contract you believe is wrong — say it plainly rather than silently deviating.
