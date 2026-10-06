"""
bg-text-norm: Bulgarian Text Normalizer for TTS
=================================================
Converts written Bulgarian text (numbers, dates, times, currency,
abbreviations) into spoken word forms for TTS preprocessing.

Usage:
    from bg_text_normalizer import normalize_text
    result = normalize_text("На 15.02.2026 г. в 14:30 ч. цената е 1500.50 лв.")

    from bg_text_normalizer import BulgarianTextNormalizer
    normalizer = BulgarianTextNormalizer()
    result = normalizer.normalize("...")
"""

from .bg_normalizer import BulgarianTextNormalizer, normalize_text
from .bg_numbers import number_to_words_cardinal, number_to_words_ordinal, float_to_words
from .bg_dates import normalize_date, normalize_year
from .bg_time import normalize_time
from .bg_currency import normalize_currency
from .bg_abbreviations import normalize_abbreviations, expand_abbreviation
from .bg_phone import normalize_phone_number
from .bg_roman import roman_to_arabic

__version__ = "1.0.0"
__all__ = [
    'BulgarianTextNormalizer',
    'normalize_text',
    'number_to_words_cardinal',
    'number_to_words_ordinal',
    'float_to_words',
    'normalize_date',
    'normalize_year',
    'normalize_time',
    'normalize_currency',
    'normalize_abbreviations',
    'expand_abbreviation',
    'normalize_phone_number',
    'roman_to_arabic',
]
