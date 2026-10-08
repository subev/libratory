# Forced alignment: word timings for audio whose engine gives none

Branch `spike/forced-alignment`, started 2026-10-08 from a research digest. A spike: try the options
on real Bulgarian audio, measure them, pick one (or two), then integrate.

## The gap

Word timings come from Kokoro and Piper (`scripts/phoneme_words.py`). Everything else is
sentence-level: BgTTS (autoregressive, no durations), MMS, Pocket, macOS `say`, and every chapter
synthesized before word timings existed. The target format is already fixed: `chunk-NNN.words.json`
beside each chunk WAV (`{text, after, startMs, endMs}` per written word), which
`buildSyncMapFromChunks` folds into a v2 sync map. Sentence-level alignment is free, because each chunk
is its own WAV, so an aligner only has to place words within one chunk of ≤ ~20 s, and a failure
stays inside that chunk.

## Options

| | What | Covers | Cost to try | Ships in the desktop app? |
| --- | --- | --- | --- | --- |
| **A** | BgTTS cross-attention: record the decoder's text attention while generating, pick the heads that align, DTW to a monotonic char→frame path (Whisper's method) | New BgTTS audio only | Nothing new. Patch `CrossAttention.forward` (SDPA → explicit softmax) at runtime from our script | Yes, already in `.venv-bgtts` |
| **C** | CTC forced alignment: `infinitejoy/wav2vec2-large-xls-r-300m-bulgarian` (Apache-2.0, Cyrillic vocab) through `transformers`, Viterbi trellis in numpy | Any Bulgarian audio, including old chapters (re-slice the chapter by the sync map's chunk spans) | ~1.2 GB model download; `.venv` already has torch + transformers, and torchaudio isn't needed | Yes, as one more model bundle |
| **B** | Montreal Forced Aligner, `bulgarian_mfa` acoustic + dictionary + G2P (CC BY 4.0) | Any Bulgarian audio | A conda env (kaldi, pynini). Needs micromamba, roughly 1 GB | Poorly. uv can't install conda packages, so it's a reference, not a product path |

Dropped: MMS_FA and `ctc-forced-aligner`'s default model (CC-BY-NC), aeneas (AGPL, dead),
WhisperX (no Bulgarian default, worst measured), NeMo NFA (no Bulgarian CTC), Qwen3-ForcedAligner
(no Bulgarian). The research's accuracy figures for MFA come from one paper I haven't verified. Treat
them as a hypothesis this spike tests.

## Ground truth without hand labelling

Piper's word timings come from its own phoneme durations, so they record when the words were
actually spoken. Synthesize ~30 Bulgarian chunks with `bg-piper:dimitar` and you have a gold set:
audio plus true word boundaries. B and C run on that audio and are scored against it. A can't be,
because it only works on BgTTS audio. Synthesize the same chunks with BgTTS and score A against C/B
agreement there, then listen to a few by ear in the reader.

Text: prose plus a number-heavy passage plus verse, because `bg_speech` expansion is where aligners
break. Every option aligns the *spoken* text and maps it back to written words with the
spoken→written step `phoneme_words.py` already has (`written_word_spans`).

## Steps

1. Spike dir `packages/server/spikes/forced-alignment/`: corpus text, a script that renders the
   Piper gold set and the BgTTS set (chunk WAVs + words.json), and a scorer (mean/median boundary
   error, share within 50/100 ms, words placed, time per audio minute).
2. A: capture cross-attention on the BgTTS set, rank heads by monotonicity, then DTW and words.
   No downloads.
3. C: CTC aligner script on both sets.
4. B: only if C or A disappoint, or as the referee where they disagree.
5. Decide, then integrate. Likely shape: A writes `words.json` during BgTTS synthesis; C becomes a
   post-hoc "time the words" job for chapters whose sync map has no words (old audio, MMS, other
   engines). The reader already says which through `granularity`.

## Results

### A: BgTTS cross-attention (2026-10-08), works and is wired in on this branch

30 Bulgarian sentences (`spikes/forced-alignment/corpus.txt`: prose, dialogue, numbers, verse). Piper
rendered them with exact word times. BgTTS was fed Piper's audio (MioCodec-encoded, one causal pass)
and its attention scored against those times. Number words are left out, because Piper spreads
their times evenly.

| word starts | median | mean | p90 | ≤100 ms |
| --- | --- | --- | --- | --- |
| A: heads 2.4 3.2 5.5, monotonic path, starts moved out of silence | 49 ms | 70 ms | 159 ms | 77% |
| Control: words spread by letter count over the voiced span | 69 ms | 117 ms | 225 ms | 65% |

- 6 of 48 heads trace a clean diagonal. The best three are chosen identically on either half of the
  set, so the pick isn't fitted to the sentences. Averaging more than three makes it worse.
- 40 ms (one codec frame) is the floor. Most words land within 1–3 frames. The big misses were the
  first word, because attention reaches the first letter during the leading silence, and that is
  fixed by not letting a word start in silence.
- The path method barely matters: DTW and "longest forward run of per-frame peaks" scored the same.
  The attention itself is the signal.
- This scores BgTTS listening to Piper's voice, not its own. Its own attention looks at least as
  sharp (rendered side by side), but its own audio has no answer key, so it is judged by ear.
- Cost: none measurable. 30 chunks, 139 s of audio: 15 s with timings, 15 s without.

Wired in: `scripts/attention_words.py` (beside `phoneme_words.py`), called from
`synthesize_bgtts.py` per chunk; `voiceHasWordTiming` is true for `bg-bgtts:`. Old BgTTS chunks have
no `words.json`, so a resumed run speaks them again (`needs_words`, as Piper does).

Open for A: no unit test yet (it needs numpy, and `phoneme-words.test.ts` runs plain python3). The
heads are fixed to this checkpoint (`MODEL_REVISION` pins it). A new BgTTS release means running
`score.py scan` again.
