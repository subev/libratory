# Finish margin-counter and page-furniture cleanup

The Strandzha extraction completed all 278 pages, but output review found residual
verse counters and page furniture in chapter text. Do not mark the whole book
ready for narration based only on successful extraction or word placement.

Evidence: `packages/server/data/recovery/extraction-review-2026-09-17/narration-cleanup-audit.json`.
The audit covers completed files 0–39, 41–94 and 95–146; extend it to 147–281.
It records candidates for review, not permission to delete every matching number.

Observed causes:

- `cleanVerseCounters` rejects detected lines wider than 450 normalized units.
  Several songs in 41–94 use full-width verse, so their real margin counters
  survive this restriction.
- Counter removal also requires an exact positioned Tesseract word match. Some
  counters visible in Surya evidence and AI text are not matched by Tesseract.
- `isPrintedPageNumber` checks every other detected line when testing isolation.
  Punctuation artifacts below a footer can stop a genuine page number from being
  excluded. Printer signatures and isolated scan artifacts also remain.

Retain raw evidence and keep counter-specific rules opt-in. Check margin position,
verse sequence and text alignment; preserve song numbers, dates, ages, numerical
verse content and footnote references. Regenerate derived output locally from
saved page results, without new Surya or DeepSeek calls. Refresh chapter text as
well as PDF geometry; replacing word positions alone does not rebuild narration.

Use the real full-width verse and footer-artifact cases as regression fixtures,
plus ordinary prose and meaningful-number controls. Keep reviewed chapter edits
and any audio safe when applying regenerated text.
