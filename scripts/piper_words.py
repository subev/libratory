"""Word timings from Piper's own phoneme durations — no aligner, no second model.

Piper (VITS) decides how many audio samples every phoneme lasts while it speaks, and
`include_alignments=True` hands those counts back. What it does not say is which phoneme belongs
to which word: espeak runs short words into their neighbours ("на хората" comes back as one
phoneme word, `nˌɐxorˈatɐ`), so splitting the phonemes at spaces matched the text's words in about
a third of the chunks measured. Instead each word is phonemized on its own and that sequence is
aligned to the sentence's phonemes symbol by symbol; a word's time is the span of the phonemes it
was matched to.

The text the voice read is not always the text on the page — `bg_speech` turns "1878 г." into six
spoken words — so spoken words are mapped back to written ones the same way, by aligning the two
token lists. Standard library only, so it is testable with any python3.
"""

import difflib
import re

# A word said alone and inside a sentence differ in stress and length marks and in the gaps between
# words; matching on the sounds alone keeps those differences from breaking the alignment.
_IGNORED = set("ˈˌːˑ")
_HAS_LETTER = re.compile(r"[^\W\d_]")
# A written number is a word on the page even though the voice says it as several
_IS_WORD = re.compile(r"[^\W_]")

# Below this share of the chunk's words placed, the timings are not worth trusting: the chunk falls
# back to sentence highlighting, as an engine with no timings does.
MIN_PLACED = 0.85
# A replaced stretch is shared out by position, which is a guess; when too little of the reading
# matched exactly, the guesses are the timings, so there are none. 120 Bulgarian chunks of prose
# and verse measured 0.86 at worst, 0.985 median (2026-10-06).
MIN_MATCHED = 0.7


def _sounds(phonemes):
    return [c for c in phonemes if c.isalpha() and c not in _IGNORED]


def spoken_word_spans(word_phonemes, timed):
    """Per spoken word, the (start, end) sample span of its phonemes, or None where none matched,
    and the share of the words' sounds found exactly in the audio's.

    word_phonemes: one phoneme string per spoken token, None for a token with no letters.
    timed: (phoneme, start_sample, end_sample) for the sentence audio, in order.
    """
    ref, owner = [], []
    for index, phonemes in enumerate(word_phonemes):
        if phonemes is None:
            continue
        for sound in _sounds(phonemes):
            ref.append(sound)
            owner.append(index)
    hyp = [(sound, start, end) for phoneme, start, end in timed for sound in _sounds(phoneme)]

    spans = [None] * len(word_phonemes)

    def claim(word, start, end):
        current = spans[word]
        spans[word] = (start, end) if current is None else (min(current[0], start), max(current[1], end))

    matcher = difflib.SequenceMatcher(None, ref, [sound for sound, _, _ in hyp], autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "delete":
            continue
        for k in range(j1, j2):
            if tag == "insert":
                # A sound the word-by-word reading lacks (a devoiced or linking consonant) belongs to
                # the word before it
                if i1 == 0:
                    continue
                ref_index = i1 - 1
            elif tag == "equal":
                ref_index = i1 + (k - j1)
            else:
                ref_index = i1 + ((k - j1) * (i2 - i1)) // (j2 - j1)
            _, start, end = hyp[k]
            claim(owner[ref_index], start, end)
    matched = sum(size for _, _, size in matcher.get_matching_blocks())
    return spans, (matched / len(ref) if ref else 0.0)


def _key(token):
    return "".join(c for c in token.lower() if c.isalnum())


def written_word_spans(written, spoken, spoken_spans):
    """Carry spoken-word spans over to the written tokens they were read from."""
    spans = [None] * len(written)
    matcher = difflib.SequenceMatcher(None, [_key(t) for t in written], [_key(t) for t in spoken], autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                spans[i1 + k] = spoken_spans[j1 + k]
            continue
        if tag == "insert":
            continue
        # One written span read as another ("1878 г." as six words): share its time out evenly
        placed = [s for s in spoken_spans[j1:j2] if s is not None]
        if not placed:
            continue
        start, end = placed[0][0], placed[-1][1]
        count = i2 - i1
        for k in range(count):
            spans[i1 + k] = (start + (end - start) * k // count, start + (end - start) * (k + 1) // count)
    return spans


def chunk_words(written_text, spoken_text, phonemize_word, timed, sample_rate):
    """ChunkWord dicts for one chunk (text as written, chunk-relative ms), or [] when unreliable.

    phonemize_word(token) -> phoneme string. A word's `text + after` rebuilds the chunk text.
    """
    written = written_text.split()
    spoken = spoken_text.split()
    if not written or not timed:
        return []

    word_phonemes = [phonemize_word(t) if _HAS_LETTER.search(t) else None for t in spoken]
    spoken_spans, matched = spoken_word_spans(word_phonemes, timed)
    if matched < MIN_MATCHED:
        return []
    spans = written_word_spans(written, spoken, spoken_spans)

    lettered = [i for i, t in enumerate(written) if _IS_WORD.search(t)]
    if not lettered or sum(spans[i] is not None for i in lettered) / len(lettered) < MIN_PLACED:
        return []

    words = []
    previous_end = 0
    for index, token in enumerate(written):
        span = spans[index]
        if span is None:
            # A dash or an unplaced word sits at the end of the one before, taking no time
            start = end = previous_end
        else:
            start, end = max(span[0], previous_end), max(span[1], previous_end)
        words.append({
            "text": token,
            "after": " " if index < len(written) - 1 else "",
            "startMs": round(start * 1000 / sample_rate),
            "endMs": round(end * 1000 / sample_rate),
        })
        previous_end = end
    return words
