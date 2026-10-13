# Keep the print marked after a text edit

Today any `customText` on an extracted chapter takes the page marking away outright: `chapterMode`
answers `text`/`edited`, `resolveRects` returns nothing, the web Reader lands on the transcript, the
chapter modal stops offering Pages, and the iOS reader hides the print. AI cleanup writes
`customText` too, so every cleaned chapter loses its highlights — the feature meant to improve
narration turns the read-along off.

The matching that puts a cue on the page is already tolerant of the print being wrong (OCR
misreads, hyphen joins, punctuation): a block's text and the page's lines are aligned by
projection, resynchronising on mismatch, and a block only has to be 60% found. The edit case
deserves the same tolerance. A fixed typo, a dropped page header, a joined hyphenated word, or an
AI pass that repairs OCR substitutions leaves nearly every word where the print has it.

## Shape

One new alignment, `customText ↔ cleanText`, computed per edited chapter and used in three places:

1. **Rects.** Cue and word ranges are located in the spoken text (`customText`) as the text view
   already does, mapped onto `cleanText` through the alignment, and resolved to rects by the
   existing `textMap → block → line` chain. Nothing downstream changes.
2. **Mode.** `chapterMode` stays `page` when the edit kept enough of the words (fit ≥ 0.6, the
   same bar as `MIN_ALIGNMENT`), with no `why`. Only an edit that replaced the text — a rewrite, a
   paste of something else — still answers `text`/`edited`. The manifest carries an optional
   `fit` (share of the spoken words found in the print) so a reader can say it is a best guess.
3. **Text blocks.** `buildText` maps the typed blocks' spans onto the edited text instead of
   dropping them, so an edited chapter keeps verse, heading and footnote kinds in the text view.

### The alignment

Token diff, not a character diff: split both texts into words, key each the way
`word-alignment.ts` does (NFD, lowercase, letters and digits only), and diff the key sequences.
`equal` runs map word for word. A `removed`+`added` pair (a replacement) maps every spoken word in
it to the whole replaced span — a corrected misread lands on the misread's own box, which is the
box wanted. `added`-only words (inserted) map to nothing and draw nothing, like punctuation does
today. Pure-punctuation tokens are left out of the diff and fall into whatever gap they sit in.

Mapping a range: take the spoken words it overlaps, map each, return `[min start, max end)` on
the clean side, `null` when nothing mapped. The diff is monotonic, so marks never go backwards.

- Algorithm: Myers via `jsdiff` (`diffArrays`), one small established dependency, with
  `maxEditLength` capped so a pathological chapter (tens of thousands of words, most of them
  changed) gives up and falls back to `text`/`edited` instead of stalling the manifest.
  Hand-rolled Myers is the alternative if the dependency is unwanted; `alignProjections` is not
  — its 64-char resync window cannot cross a deleted header or footnote.
- Cached by chapter id against the two strings it was built from, since the manifest is built on
  every poll and calls `chapterMode` for every chapter.
- `fit` = equal spoken words / all spoken words.

### Which text the cues came from

Cues are slices of whatever was narrated. Narrated after the edit: cue text locates in
`customText`, maps through the alignment. Edited after narration: cue text still locates in
`cleanText` directly, which is what happens today, and the text view's `range` is what fails —
also as today. `resolveRects` tries the spoken text first and falls back to `cleanText`, so both
orders keep whatever can be kept.

## Steps

1. `lib/text-alignment.ts` + tests: tokenise, diff, `fit`, `mapRange`, inverse map, the cap.
   Cases: a one-word fix, a dropped page number, a joined hyphenation, a deleted footnote line
   (> 64 chars), an inserted sentence, the AI-cleanup fixture shape, a full rewrite (fit well
   under 0.6), identical texts (identity).
2. `reader-doc.ts`: `chapterMode` consults the alignment for an edited chapter and reports `fit`;
   `resolveRects` locates in the spoken text and maps; `buildText` maps blocks. Tests beside the
   existing `edited` ones; `chapterMode` test splits into "small edit keeps the page" and "rewrite
   loses it".
3. `reader-format.ts`: optional `fit?: number` on `ReaderChapter`. Docs: `read-along.md` (`why`
   paragraph) and `read-along-variations.md` (the two "mapping is lost" rows become "kept as a
   best guess; a rewrite loses it").
4. Web: no gating change — `printHoldsText` already offers Pages when `why` is absent. Add a
   quiet note (NOTE_BANNER) on an edited chapter in page view: text was edited, the print is lined
   up as a best guess with N% of the words placed, text view marks every word. `UNMAPPED.edited`
   copy becomes "changed too much to line up with the print". e2e `uc8` keeps its rewrite case
   (still drops the print) and gains a small-correction case that keeps `cue-rect`s.
5. `routes/chapters.ts` chunk previews: use the alignment to find the exact block page for chunks
   taken from `customText` instead of scaling offsets onto `rawText`.

Out of scope: variants (another text entirely), chapters narrated before `textMap` existed, and
`generated` chapters.

## Cross-repo

The iOS reader needs no change for the main path: an edited chapter now arrives as `mode: page`
with no `why`, which it already reads as markable. Its `.edited` notice copy still fits the
fallback. It may want to show `fit` the way the web does; that is its call.
