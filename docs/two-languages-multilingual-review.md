# Follow-up: implementation and multilingual word pairing

The revised spike adopts the important architectural recommendations: persisted token occurrences,
shared counterparts, stable pair references within an artifact, per-edge timing provenance, and
explicit failures without automatic retries. Keep that direction. The remaining sentence trust
rules are heuristics, and the word-level benchmark needs care when interpreting its precision.

## Implementation review

The existing 13 tests passed. Two additional regression tests failed before the fixes and now pass:

- `p1: 999 = -` used to mark a pair answered without validating the source token. No-counterpart
  lines now validate IDs just like links.
- A response ending because of the output limit could mark all its pairs answered despite being
  incomplete. A non-`stop` finish now records a failed batch and publishes no links from that batch.
  The raw response is retained for inspection, and other completed batches remain available.

Link calls now have an output-token limit and an optional explicit model selection. The experiment
pins the cheap `flash` configuration rather than relying on the user's current default. Optional
experimental prompt guidance leaves the existing default wording unchanged.

The previous AER comparison is useful but does not isolate semantic quality: it expands grouped
phrases into a Cartesian product of token relations. A broad phrase link therefore accumulates
penalties that separate links avoid. The saved final comparison reports content recall of 0.920 for
quotes versus 0.893 for IDs, despite much higher token-relation precision for IDs. The prompt was
also adjusted using that same chapter, so it is a development set, not an independent held-out test.
Keep group-level behavior and word-level precision as separate measurements. An agent-authored
label set should not be described as independent human annotation.

The sentence scorer still returns no outliers at all for fewer than five matches; a uniformly bad
chapter also lacks a good relative baseline. Its merge-removal rule can discard a valid sentence
whose removal happens to improve cosine similarity. Passing the original two stress cases does
not resolve these limitations. This follow-up deliberately concentrated on word mapping.

## New experiment

Ten short sentence pairs each for **English–Hebrew** and **Bulgarian–German**, with 19 targeted
semantic checks per pairing. Fixtures and expected occurrence identities were written before
model calls. These are agent-authored sanity checks, not native-reviewed gold labels or a complete
precision/recall benchmark. They deliberately isolate word mapping with known sentence pairs;
they do not evaluate sentence segmentation/alignment.

Cases cover repeated words and pronouns, negation, separable verbs, compounds, attached Hebrew
prefixes, discontinuous expressions and mixed-direction numbers. Three independent calls per
pairing use `deepseek-flash`, temperature 0.3, no retries, with a 4096-output-token cap.

| Prompt | English–Hebrew checks recovered | Bulgarian–German checks recovered | Invalid lines |
| --- | --- | --- | --- |
| Existing token-ID prompt | 19/19, 19/19, 19/19 | 18/19, 19/19, 18/19 | 0 |
| Additional compound/grammar guidance | 19/19, 19/19, 18/19 | 18/19, 18/19, 19/19 | 2 |

Every requested pair was mentioned in all twelve calls. The existing prompt's repeated miss was
`реката` (river) as a contributor to German `Flussufers` (riverbank): it linked the bank part and
omitted the river part. The additional guidance did not fix that reliably and missed the final
`her` once in the Hebrew pairing. Its two invalid lines were target-only no-counterpart statements
(`p9: - = 7`) outside the requested grammar; they were recorded rather than silently accepted.
The original prompt stays the default. There is no evidence here to promote the alternative.

High recovery of these checks does **not** mean all emitted links are correct. For example, a
Hebrew run links English `the` to the Hebrew definite-object marker `את`, which is not the same
grammatical function. Content relations and optional grammatical relations need separate evaluation.
Do not respond to this with hard-coded English/Hebrew rules.

## Actual audio revealed a separate limitation

The English lane uses offline Kokoro `af_heart`. The other lanes use Cartesia `sonic-3.6`:
Hebrew Ayala, Bulgarian Ivana, and German Clemens. Each take is about 20–23 seconds. Voice IDs,
text hashes, requested model IDs and creation dates are saved beside the audio. `sonic-3.6` is a
rolling alias, not a pinned model snapshot.

| Lane | Located / reported word entries | Additional finding |
| --- | --- | --- |
| English | 78/78 | No zero-duration word intervals |
| Hebrew | 50/50 | All 50 durations are 406 or 407 ms, with contiguous edges |
| Bulgarian | 56/56 | 12 zero-duration words, including negation/pronouns |
| German | 71/71 | 7 zero-duration words |

Every word entry can be located in the written text. That only establishes text correspondence.
The Hebrew intervals divide the recording evenly; this looks like interpolation and is not
evidence of acoustically aligned word boundaries. The Cartesia adapter here only converts the
returned seconds to milliseconds; it does not manufacture those evenly spaced intervals.
The underlying provider behavior has not been established from documentation or human annotation.

Zero-duration intervals can never satisfy `start <= playbackTime < end`, so those words will not
light during playback. Do not fabricate positive durations and continue calling them measured
word timings. Retain the data and expose the limitation; an optional estimated presentation interval
must be distinguished from the acoustic interval. Provider provenance and quality evidence are
separate fields, not interchangeable claims of exactness.

The new viewer shows these warnings and preserves normal Hebrew direction, including `08:30`.
It handles a display token overlapping multiple timed entries and highlights every linked
counterpart. Automated browser checks verified RTL, hover links, the German split verb and
click-to-seek playback. Screenshots were inspected. No native listening review or manual acoustic
boundary annotation was performed, so no timing accuracy or voice-quality score is claimed.

## Artifacts and reproduction

Source: `packages/server/spikes/two-languages/review/multilingual-fixtures.mts`, `multilingual.mts`,
`multilingual.template.html`, and `verify-viewer.mjs`.

Outputs: `packages/server/data/tmp/two-languages-spike/multilingual/`:

- `view.html`: original token-ID prompt with both pairings and all three runs.
- `view-refined.html`: unsuccessful prompt alternative, kept for comparison.
- `report.json` / `report-refined.json`: checks, resolved links, and timing diagnostics.
- `*-links-*.json`: raw answers, token usage, errors and fixture hashes.
- `*.wav` / `*.sync.json`: recordings and their provider timing data.
- `viewer-he.png` / `viewer-de.png`: browser verification screenshots.

From `packages/server`:

```bash
node_modules/.bin/vitest run --config spikes/two-languages/review/vitest.config.ts
node --import tsx spikes/two-languages/review/multilingual.mts
node --import tsx spikes/two-languages/review/multilingual.mts --refined
node spikes/two-languages/review/verify-viewer.mjs
```

Those commands reuse saved data without paid calls. `--links` generates missing run files and
`--audio` generates missing recordings; these flags are intentionally explicit. Adding `--refined`
selects the separate candidate results. Inspect existing artifacts before deliberately deleting
them to rerun an experiment. No model downloads or database access are required for the saved replay.

This run used 906 Cartesia characters and 14,562 input / 7,403 output LLM tokens across both
prompt versions. Estimated total is under $0.06 using peak Flash prices and Cartesia Pro's
allocated-credit equivalent, not an account invoice. Pricing references:
[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/),
[Cartesia](https://www.cartesia.ai/pricing). No new dependencies, production edits or commits.

Next useful work is a small same-audio timing audit and an independent passage for semantic
evaluation. Keep the ID contract; avoid accumulating prompt rules without demonstrated improvement.
