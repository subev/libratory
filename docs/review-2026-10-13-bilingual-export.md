# Bilingual export review — 2026-10-13

Reviewed the complete outgoing change from `6b9d4b53`, including both fixes,
both regression tests and this report. No findings or unresolved blockers.
Unrelated changes in the original checkout and its menu-fix commit are excluded.

## Findings and behavior

- `packages/server/src/lib/bilingual-timing.ts:46`: punctuation-only passages
  now have unavailable timing on both edges. This uses the existing meaningful-text
  predicate and nullable timing contract; it neither changes saved links nor audio.
  Checked document validation and reader consumers: unavailable anchors are supported.
- `packages/server/src/routes/books.ts:1168`: pending exports exclude unlocked
  jobs with exhausted attempts, retaining queued and locked/running jobs. This
  matches the existing `owedJobs` predicate and does not retry or delete jobs.
- `packages/server/src/lib/bilingual-preparation.test.ts:115`: regression uses
  an unspoken dotted separator between chunks with a 40 ms gap between the
  preceding chunk end and following word start, reproducing the reversed edges.
- `packages/server/src/routes/books.test.ts:39`: regression checks exhausted,
  queued, retryable and running jobs, plus exclusion of other books and tasks.

## Reproduction and verification

The reported book's Bulgarian Mr. Tod passage p80 contains only spaced dots.
Before the fix its start was 421639 ms and its end was 421599 ms. All four
chapters' pairing/linking jobs were done. After the fix, constructing the real
four-chapter bilingual export layer with both narrations passed validation.

In an isolated worktree based on origin/main:

- `pnpm lint`: passed (existing warnings).
- `pnpm typecheck`: passed.
- `pnpm test`: 1343 passed, 5 skipped across server, web and desktop.
- `git diff --check`: passed.

The first test attempt selected incompatible Intel tools and lacked the Python
virtual environment. The passing run used `/opt/homebrew/bin` first on PATH and
`CONDA_ENV_PATH=/Users/petur/repos/libratory/.venv/bin`; no dependencies were installed.
No paid model calls, audio synthesis, local browser E2E run or packaged desktop
acceptance run was performed. Release CI remains responsible for its own checks.
