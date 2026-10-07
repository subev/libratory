"""Bulgarian written forms → spoken forms, for the engines that read nothing but Bulgarian.

These models read digits, dates and abbreviations badly or not at all (MMS drops digits from its
vocabulary; BgTTS-38M skipped a third of a number-heavy passage). The text shown and highlighted
stays as written — only what the model is asked to say changes.
"""
import re
import sys

from bg_text_normalizer import normalize_text
from bg_text_normalizer.bg_abbreviations import ADDRESS_ABBREVS, GEO_ABBREVS, TITLE_ABBREVS

# A dot that ends a sentence and an abbreviation at once ("през 1878 г. Тогава") is consumed by the
# expansion, and the model loses the pause. Mark every sentence-final dot first; the mark turns back
# into a dot only where its own dot was eaten. An abbreviation that precedes its noun ("гр. София",
# "проф. Петров") is not a sentence end even before a capital, so it is never marked.
_SENTENCE_END = re.compile(r"(?<=\w)\.(?=\s*$|\s+(\w))")
_PREFIX_ABBREVS = tuple(sorted(
    {a.lower() for a in (*ADDRESS_ABBREVS, *GEO_ABBREVS, *TITLE_ABBREVS) if a.endswith(".")}
    | {"т.е.", "т. е.", "т.нар.", "напр.", "вж.", "ср.", "вкл.", "изд.", "стр.", "гл.", "чл.", "ал."},
    key=len, reverse=True,
))


def _ends_with_prefix_abbrev(before: str) -> bool:
    lowered = before.lower()
    for abbrev in _PREFIX_ABBREVS:
        if lowered.endswith(abbrev):
            start = len(lowered) - len(abbrev)
            if start == 0 or not lowered[start - 1].isalnum():
                return True
    return False
_MARK = ""

_warned = False


def _mark_sentence_ends(text: str) -> str:
    def repl(m: re.Match) -> str:
        following = m.group(1)
        if following is not None and (not following.isupper() or _ends_with_prefix_abbrev(m.string[:m.end()])):
            return "."
        return "." + _MARK
    return _SENTENCE_END.sub(repl, text)


def _restore_sentence_ends(text: str) -> str:
    return re.sub(r"\.?" + _MARK, ".", text)


def speakable(text: str) -> str:
    global _warned
    try:
        return _restore_sentence_ends(normalize_text(_mark_sentence_ends(text)))
    except Exception as exc:  # a normalizer bug must cost the expansion, never the chapter
        if not _warned:
            print(f"bg normalizer failed, reading text as written: {exc}", file=sys.stderr)
            _warned = True
        return text.replace(_MARK, "")
