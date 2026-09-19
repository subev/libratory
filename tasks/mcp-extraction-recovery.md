# Reach saved-page recovery from MCP

Found by the pre-release review of v26.919.0 (2026-09-19). Not a bug in the web app; a gap in the
agent surface.

A page the AI engine read but whose response failed validation is kept as
`ocr-failure-page-<n>-<ts>.json` and is not in `llm-pages.json`. Two things can happen to it next:

- `bookFiles.resumeExtraction` (the web's Saved pages and recovery modal) passes a `repairLimit`, so
  the standard route goes through `validatedStage`: the saved response is validated again locally,
  and only an authorised repair call reaches the model.
- Every other run — `bookFiles.reExtractSelected`, `books.extractChapters` — passes no budget, so
  `runLlmOcr` calls `readPage` and asks the model for that page afresh (`lib/ocr-llm.ts`, the
  `input.repairBudget ?` branch). That is one paid call per unresolved page per run. It is what a
  person pressing Extract again means, and pages already read are never paid for twice.

The MCP `extract_book` tool only reaches the second path. An agent that retries a failing book in a
loop pays for the same rejected pages each time, about a tenth of a cent a page, and has no tool that
reaches the cheaper one or that says which pages are unresolved.

Direction: report `reviewPages` / `interruptedPages` (`lib/ocr-progress.ts`) through `get_book`, and
give `extract_book` an optional `repairLimit` that routes to `resumeExtraction` when saved pages
exist. Keep the tool count where it is — this is a parameter, not a new tool.
