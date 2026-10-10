"""Fits a sentence to Kokoro's 510-entry voice pack by splitting its text, never its phonemes.

A phoneme string cut at a space loses its tokens, and with them every word timing; the sync map
then carried the whole sentence's text twice, once per piece. Cutting the text at a clause
boundary and reading each half again keeps every piece timed. Standard library only, so the test
drives it with a fake reader.
"""

import json
import os
import re

MAX_PHONEMES = 510

# A clause boundary: punctuation followed by space, or a spaced dash
_CLAUSE = re.compile(r"[,;:]\s+|\s+[-–—]\s+")
_SPACE = re.compile(r"\s+")


def split_text(text):
    """The two halves of a sentence, cut at the clause boundary nearest its middle — within the
    middle half, so one early comma does not leave a fragment — else at the nearest space.
    None when there is nowhere to cut."""
    text = text.strip()
    middle = len(text) / 2
    lower, upper = len(text) / 4, 3 * len(text) / 4
    best = None
    for m in _CLAUSE.finditer(text):
        cut = m.end()
        if lower <= cut <= upper and (best is None or abs(cut - middle) < abs(best - middle)):
            best = cut
    if best is None:
        for m in _SPACE.finditer(text):
            cut = m.end()
            if 0 < m.start() and cut < len(text) and (best is None or abs(cut - middle) < abs(best - middle)):
                best = cut
    if best is None:
        return None
    left, right = text[:best].strip(), text[best:].strip()
    if not left or not right:
        return None
    return left, right


def _hard_cut(phonemes, text, max_phonemes):
    """The old behaviour, kept for a run of text with no space to cut at: the phonemes are cut
    and the pieces carry no tokens, so they are the one case still without word timings."""
    pieces = []
    while len(phonemes) > max_phonemes:
        at = phonemes.rfind(" ", 0, max_phonemes)
        if at <= 0:
            at = max_phonemes
        pieces.append((phonemes[:at], text, None, False))
        phonemes = phonemes[at:].lstrip()
    if phonemes.strip():
        pieces.append((phonemes, text, None, False))
    return pieces


def cached_chunk_texts(chunks_dir):
    """The texts an earlier run cut this chapter into, from its chunks.json manifest."""
    if not chunks_dir:
        return []
    try:
        with open(os.path.join(chunks_dir, "chunks.json"), encoding="utf-8") as f:
            return [entry["text"] for entry in json.load(f)]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def drop_stale_chunks(chunks_dir, cached_texts, chunk_texts, words_file):
    """Removes the cached audio and words of every index whose text this run's cut changed, and
    of every index past the new count, before the manifest is rewritten. A resume reuses chunks by
    index, and the cut can change between versions: from the first changed sentence on, every
    index would name a different chunk, and a run interrupted after rewriting the manifest would
    hand the next resume another cut's audio under a text that now matches."""
    if not chunks_dir or not cached_texts:
        return
    for index, cached in enumerate(cached_texts, start=1):
        if index <= len(chunk_texts) and chunk_texts[index - 1] == cached:
            continue
        for name in (f"chunk-{index:03d}.wav", words_file(index)):
            try:
                os.remove(os.path.join(chunks_dir, name))
            except FileNotFoundError:
                pass


def fit_chunks(g2p, en_tokenize, segment, max_phonemes=MAX_PHONEMES):
    """[(phonemes, text, tokens, timed)] for one segment of text.

    g2p(text) -> (phonemes, tokens), tokens None for an espeak-backed language;
    en_tokenize(tokens) -> iterable of (text, phonemes, tokens) chunks, English only.
    A piece over the limit is split by its text and read again, so tokens stay in step with the
    phonemes; `timed` is False only for a piece that had to be cut in its phonemes."""
    phonemes, tokens = g2p(segment)
    if tokens is None:
        if not phonemes.strip():
            return []
        if len(phonemes) <= max_phonemes:
            return [(phonemes, segment, None, True)]
        halves = split_text(segment)
        if halves is None:
            return _hard_cut(phonemes, segment, max_phonemes)
        return fit_chunks(g2p, en_tokenize, halves[0], max_phonemes) + fit_chunks(g2p, en_tokenize, halves[1], max_phonemes)

    pieces = []
    for text, chunk_phonemes, chunk_tokens in en_tokenize(tokens):
        text = text.strip()
        if not chunk_phonemes.strip():
            continue
        if len(chunk_phonemes) <= max_phonemes:
            pieces.append((chunk_phonemes, text, chunk_tokens, True))
            continue
        halves = split_text(text)
        if halves is None:
            pieces.extend(_hard_cut(chunk_phonemes, text, max_phonemes))
            continue
        pieces.extend(fit_chunks(g2p, en_tokenize, halves[0], max_phonemes))
        pieces.extend(fit_chunks(g2p, en_tokenize, halves[1], max_phonemes))
    return pieces
