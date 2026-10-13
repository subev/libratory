# Review: bilingual reader highlights every token of a timed word (2026-10-13)

Scope: the uncommitted reader change that lights every display token covered by the word being
spoken, and combines their counterpart links. Files: `packages/server/src/lib/bilingual-format.ts`,
`packages/web/src/lib/bilingual-reading.ts`, `packages/web/src/lib/bilingual.test.ts`,
`packages/web/src/components/reader/BilingualReader.tsx`, `BilingualPassage.tsx`, and the new
`BilingualReader.test.tsx`. Reviewed in context by a second agent; the implementation was not edited
during the review.

## Defect

Display tokens are `Intl.Segmenter` word segments (`bilingual-segment.ts:48-55`), which break on
hyphens in every language: `so-called`, `по-добре`, `dit-elle` are two tokens each. Every engine
times such a compound as one word (`elevenlabs.ts:233-253`, `cartesia.ts:190-199`,
`scripts/attention_words.py:145-154`, `scripts/phoneme_words.py:121`), so one word anchor
(`bilingual-document.ts:54-57`) covers two tokens. The reader took the first token inside the anchor
and that token's links only, so the second half and part of its meaning never lit. 1605 of 1876
sync maps on one machine hold at least one hyphenated timed word. Elisions such as `Lorsqu’elle`
are one token and one word, and were already right.

## Change

- `tokensAtTime` (`bilingual-format.ts:180-183`) returns every token that intersects the active
  word anchor, half-open on both sides, instead of the first token contained in it.
- `wordHighlight` (`bilingual-reading.ts:3-13`) keeps the tokens inside the active pair's range and
  unions the direct links of each; no transitive expansion through a shared token.
- `BilingualReader.tsx:67-68, 272-273` derive the highlight from `wordHighlight` and pass a list of
  speaking tokens; `BilingualPassage.tsx:13, 26` mark each of them. Click and seek
  (`listenPosition`, `bilingual-reading.ts:30-35`) are unchanged.

## Findings

1. Per-tick recomputation undoes a documented optimisation (P2, fix before commit). The highlight
   is memoised on `ms` (`BilingualReader.tsx:67`), which changes every published tick (100 ms,
   `use-audio-time.ts:6`), and returns fresh arrays each time. `BilingualPassage` is memoised so a
   passage skips reconciliation while its highlights are unchanged
   (`docs/bilingual-reader-review-handoff.md:312-313`); before the change the active token object
   was stable within a word, so the two active passages re-rendered once per word. Now they
   re-render ten times a second. Suggested fix: look the anchor up first and memoise on it, for
   example `wordAnchorAt(lane, ms)` returning the anchor object, `tokensAtTime` taking the anchor,
   and `useMemo(() => wordHighlight(lane, activePair, side, anchor), [lane, activePair, side, anchor])`.
   The scroll-follow effect already keys on the joined ids and needs no change.
2. Intersection instead of containment: not a material issue. For an anchor finer than a token (a
   provider splitting `Lorsqu’elle`), the whole token now lights instead of nothing. For an anchor
   straddling two pairs (`end.Next`), the pair filter keeps only the current pair's tokens, covered
   by the third reader test. The one behavioural difference worth knowing: `locateWords` places a
   reported word with a plain `indexOf` (`bilingual-timing.ts:38`), so a short word mislocated inside
   a longer one now lights that longer word for its duration where it lit nothing before. That is a
   pre-existing location weakness, not introduced here.
3. The speaking tokens are now gated on the pair found by passage timing (`pairAtTime`) rather than
   the pair containing the token. These agree by construction: a passage's start edge is its first
   located word's start (`bilingual-timing.ts:59-66`), and a gap between passages has no word anchor.
   The change removes an old inconsistency where the counterpart was looked up on the timed pair with
   a token id from another pair. No change needed.
4. Two dated records still name `tokenAtTime` (`docs/mcp-dogfood-bilingual-2026-09-30.md:139`,
   `docs/bilingual-reader-simplify-findings.md:90`). They describe the code as it was; left as is.

## Verification

- `tsc --noEmit` clean in `packages/web` and `packages/server`; `oxlint` clean on the six files.
- `vitest run` on `bilingual.test.ts`, `bilingual-reading.test.ts`, `BilingualReader.test.tsx`: 3
  files, 33 tests pass. The table test covers `so-called`, `по-добре`, `dit-elle` and the
  `Lorsqu’elle` control through the real tokenizer; the reader test renders the second of two
  repeated compounds with both halves and both counterparts marked, the gap and zero-duration cases
  with the sentence band kept and no word mark, a spanning anchor cut to its pair, and an uncertain
  pair with no links. `linkedom` and `react-dom/server` follow the pattern of the existing
  `structured-text.test.tsx`; `linkedom` is a root dependency.
- Failure before the fix was checked by reasoning, not by reverting in the shared working tree:
  containment with `find` yields the first token only, so each table row's expected list differs.
- Offline reproducer used for the audit:
  `/private/tmp/claude-501/-Users-petur-repos-libratory/327f57bd-ffb8-47b9-b925-10c4a1836305/scratchpad/hyphen-highlight-repro.mjs`.

## Gaps

- Not run in a browser or through the bilingual e2e spec; the reader test is static markup, so the
  live tick path and scroll following are untested here.
- Cartesia's own word splitting is unverified; if it is finer than display tokens, intersection
  lights the whole token, which is the intended outcome, but no recording was checked.
- Cloud number expansion ("1984" spoken as four words) still leaves those words unanchored
  (`bilingual-timing.ts:39`): the sentence band stays, the word mark goes silent. Unchanged.

## Disposition (same day)

Finding 1 fixed and rechecked. `wordAnchorAt` (`bilingual-format.ts:180-182`) returns the persisted
anchor object, `tokensForAnchor` (`:184-186`) does the intersection, and `tokensAtTime` stays as the
convenience wrapper. The reader memoises on `[lane, activePair, side, wordAnchor]`
(`BilingualReader.tsx:67-68`), so within one spoken word the arrays keep their identity and the
passage memo holds; in a gap the anchor is `null` on every tick, with the same effect. The reader
test asserts the same anchor object across two ticks (`BilingualReader.test.tsx:49`), and a
half-open partial-token case was added (`bilingual.test.ts:125`). Rechecked: `tsc --noEmit` clean in
web and server, `oxlint` clean on the six files, the three focused files pass (34 tests). Findings
2–4 stand as recorded; no change needed.

## Release review clarification

The compound reproductions establish a reader defect when a timed word spans several display
tokens. The earlier phrase “every engine” is too broad: Cartesia forwards its provider word list,
and its splitting was not measured. The fix supports both whole-compound and finer anchors;
no claim of universal provider segmentation is needed.

Release gate (isolated checkout at main 65bf723 plus this change): lint, typecheck and build
passed; 1,409 unit/integration tests passed with five skipped; six release-script tests passed.
Full Playwright E2E passed 35 tests with one skipped, including local extraction, synthesis,
assembly, exports and read-along. The compound-specific regression remains a static reader
render test. Initial native-tool failures were resolved by selecting the installed Apple Silicon
Python and Tesseract on PATH. Full outgoing code, tests, fixtures and this report reviewed;
no remaining blocking findings. No real-provider accuracy claim or saved-link regeneration.
