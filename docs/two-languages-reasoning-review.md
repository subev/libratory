# Flash reasoning experiment — 2026-09-28

With enough output allowance, Flash reasoning completed all six calls and recovered all 19
selected checks on both language pairings. It consistently fixed the German compound miss and
avoided the questionable Hebrew article links. It also introduced overly broad phrase grouping
in one run and one invalid line. **Useful improvement on specific cases, not a clean overall win.**
Keep the token-ID contract; do not change the default solely from these small results.

## Controlled inputs

Three calls for English–Hebrew and three for Bulgarian–German per setting, each using the same
ten sentence pairs, token tables and prompt. Requested model: `deepseek-flash` (the repository's
`flash` choice, not Gemini Flash). New responses also identify themselves as `deepseek-flash`.
This is an alias, not a pinned snapshot. All variants requested temperature 0.3; that does not
establish that the provider applies sampling settings identically in both modes.

The initial reasoning experiment raised the baseline's 4096 output cap to 8192. All six calls
exhausted that cap on reasoning before returning any final text. I chose too small a cap for this
configuration. Those results are incomplete and unscored, not evidence of poor semantic quality.
The user then explicitly authorized a tenfold increase, to **81,920 tokens per call**, for six
new calls. The timeout increased from ten to thirty minutes; no call reached it. There were no
automatic retries, stronger-model calls, or new audio generation.

New artifacts record exact system/user prompts, input hashes, requested/returned model IDs,
finish reasons and token usage. Baseline artifacts predate the full prompt/response-model
logging; the comparison uses the unchanged prompt implementation and matching fixture hashes.

## Results

| Pairing | Reasoning off: checks | Off: latency | Reasoning with 81,920 cap: checks | On: latency |
| --- | --- | --- | --- | --- |
| English–Hebrew | 19/19, 19/19, 19/19 | 2.1–2.6 s | 19/19, 19/19, 19/19 | 50.2–92.4 s |
| Bulgarian–German | 18/19, 19/19, 18/19 | 2.2–2.5 s | 19/19, 19/19, 19/19 | 53.9–87.5 s |

The larger-budget calls used 11,297–23,019 total output tokens apiece; none approached 81,920.
All finished with `stop`, with no missing pairs. Five had no invalid lines; the last German run
emitted `p9: - = 7`, a target-only no-counterpart statement outside the requested grammar.
The validator recorded it as invalid and retained the valid links; it did not silently reinterpret it.

Concrete improvements:

- All three German reasoning runs link both `брега` (bank) and `реката` (river) to `Flussufers`.
  Two of three baseline runs omitted the river contribution.
- None of the Hebrew reasoning runs links English `the` to the definite-object marker `את`.
  The first baseline run did so twice. The distinction between grammatical correspondence and
  lexical correspondence still needs an explicit annotation policy.

Concrete regression:

- The last German reasoning run groups `Малкото момче` with `Der kleine Junge`, and similarly
  groups the little girl phrase. The whole phrases correspond, but the adjective and noun are
  independently alignable. Tapping “small” also highlights “boy” or “girl”, making the word-level
  result less precise. The baseline and the other two reasoning runs separate these content words.

The original 19 checks only require selected relations to be present, so this over-grouping
still passes. The report now adds four **post-hoc** counterpart probes for those adjective/noun
cross-links; only the final German reasoning run triggers them. They were added after observing
the output and are reported separately, not passed off as a predeclared benchmark. The earlier
16 Hebrew / 15 German wrong-content probes were not triggered in any completed run. Neither
probe set measures overall precision. Fixtures and checks are agent-authored, not native-reviewed.

Grouping is not inherently wrong: Hebrew attached prefixes and German separable verbs need
shared or discontinuous counterparts. Sometimes multiple source tokens genuinely correspond to
one target token. The current ID-group representation handles this. Banning groups to improve a
score would discard useful behavior; evaluating whether a group is unnecessarily broad is the
better direction. Grammar placement also varies between runs without changing core content.

## Cost and decision

The six larger-budget calls used **7263 input / 101,664 output tokens**, including 98,618
reasoning tokens, over 416.8 seconds of sequential calls. Estimated cost at published peak
cache-miss rates ($0.30/M input, $1.20/M output): **$0.1242**. The earlier capped calls used
7263 input / 49,152 output tokens, estimated at **$0.0612**. Combined reasoning experiments:
**about $0.1854**, conservatively; actual billing can be lower due to cache and off-peak rates.
This is not an account invoice. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/?push_animated=1&show_loading=0&theme=light&webview_progress_bar=1).

Reasoning is worth keeping as an explicit quality experiment or optional slower setting. These
runs demonstrate that the token-ID contract accepts better compound/morphology decisions without
changing storage or playback, but do not establish a generally superior model configuration.
A stronger model remains untested. Before another model comparison, add an independent passage
and evaluate extra/wrong counterparts and unnecessary grouping as well as recovered links.
Do not tune more prompt rules against only these twenty short pairs and call the result general.

Keep text links independent of narration timing and preserve the full token groups, input hashes,
model/prompt provenance and failure state. Improving the mapping model cannot repair the already
recorded uniformly spaced Hebrew timestamps or Bulgarian/German zero-duration words; those are
separate audio-timing problems described in the [multilingual review](two-languages-multilingual-review.md).

## Artifacts and verification

The gitignored directory `packages/server/data/tmp/two-languages-spike/multilingual/` contains:

- `comparison.html`: results table, including invalid lines and broad-counterpart warnings.
- `view.html`, `view-reasoning.html`, `view-reasoning-large.html`: playable variants with navigation.
- `*-links-*-reasoning*.json`: final answers, exact prompts, hashes, model IDs, finish reasons,
  elapsed times and token counts. Private reasoning text is not saved.
- `report-reasoning*.json` and `reasoning-comparison.json`: measurements and readable links.

Saved-data replay, from `packages/server`, makes no paid calls:

```bash
node --import tsx spikes/two-languages/review/multilingual.mts
node --import tsx spikes/two-languages/review/multilingual.mts --reasoning
node --import tsx spikes/two-languages/review/multilingual.mts --reasoning-large
node --import tsx spikes/two-languages/review/reasoning-audit.mts
node_modules/.bin/vitest run --config spikes/two-languages/review/vitest.config.ts
node spikes/two-languages/review/verify-viewer.mjs
```

Adding `--links` explicitly generates only missing artifacts. Existing failed run files are
retained and skipped. The 15 focused regression tests, focused TypeScript check and spike lint
passed. Browser checks cover RTL, word links, seek playback, unscored incomplete responses and
the comparison table. Production behavior and the default prompt were not changed. No commits.
