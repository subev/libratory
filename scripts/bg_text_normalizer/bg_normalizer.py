"""
Bulgarian Text Normalizer for TTS
==================================
Converts written Bulgarian text into its spoken form for TTS systems.
Handles: numbers, dates, times, currency, abbreviations, percentages,
         phone numbers, ordinals, Roman numerals, and more.

Usage:
    from bg_text_normalizer import BulgarianTextNormalizer
    normalizer = BulgarianTextNormalizer()
    text = normalizer.normalize("На 15.02.2026 г. в 14:30 ч. цената е 1500.50 лв.")
    # Output: "На петнадесети февруари две хиляди двадесет и шеста година в четиринадесет и тридесет часа цената е хиляда и петстотин лева и петдесет стотинки."
"""

import re

from .bg_numbers import (
    number_to_words_cardinal,
    number_to_words_ordinal,
    float_to_words,
)
from .bg_dates import normalize_date, normalize_year, MONTH_NAMES
from .bg_time import normalize_time
from .bg_currency import normalize_currency
from .bg_abbreviations import normalize_abbreviations, expand_abbreviation
from .bg_phone import normalize_phone_number
from .bg_roman import roman_to_arabic


class BulgarianTextNormalizer:
    """Main normalizer class that orchestrates all sub-normalizers."""

    def __init__(self, expand_abbrevs: bool = True, verbose: bool = False):
        self.expand_abbrevs = expand_abbrevs
        self.verbose = verbose

    def normalize(self, text: str) -> str:
        """
        Normalize Bulgarian text for TTS.
        Applies normalizations in a specific order to avoid conflicts.
        """
        if not isinstance(text, str):
            raise TypeError(f"Expected str, got {type(text).__name__}")
        if not text.strip():
            return text

        # Step 1: Normalize abbreviations first (before numbers eat the dots)
        if self.expand_abbrevs:
            text = normalize_abbreviations(text)

        # Step 2: Collapse space-separated large numbers: 7 000 000 → 7000000
        text = self._collapse_spaced_numbers(text)

        # Step 3: Percentages (before dates, since 15.5% could match as date)
        text = self._normalize_percentages(text)

        # Step 4: Dates (before generic numbers, since dates contain numbers)
        # Matches: 15.02.2026, 15.02.2026 г., 15/02/2026, 15-02-2026
        text = self._normalize_dates(text)

        # Step 5: Time (before generic numbers)
        # Matches: 14:30, 14:30 ч., 9:05 часа
        text = self._normalize_times(text)

        # Step 6: Currency (before generic numbers)
        # Matches: 1500.50 лв., 25 лв, $100, €50, 100 EUR
        text = self._normalize_currency(text)

        # Step 7: Phone numbers
        text = self._normalize_phones(text)

        # Step 8: Roman numerals (before generic numbers)
        text = self._normalize_roman_numerals(text)

        # Step 9: Symbols (№, &, etc.)
        text = self._normalize_symbols(text)

        # Step 10: Ordinal numbers (before cardinals)
        # Matches: 1-ви, 2-ри, 3-ти, 15-ти, 1-ва, 2-ра
        text = self._normalize_ordinals(text)

        # Step 11: Standalone years (4-digit numbers that look like years)
        text = self._normalize_standalone_years(text)

        # Step 12: Cardinal numbers (generic number-to-words)
        text = self._normalize_cardinal_numbers(text)

        # Step 13: Clean up extra whitespace
        text = re.sub(r'\s+', ' ', text).strip()


        return text

    def _collapse_spaced_numbers(self, text: str) -> str:
        """Collapse space-separated digit groups into single numbers.
        E.g., '7 000 000' → '7000000', '1 500' → '1500'
        But not 'в 5 часа' (single digits followed by words).
        """
        # Match digit groups separated by spaces where each group after first is exactly 3 digits
        pattern = r'\b(\d{1,3})((?:\s\d{3})+)\b'
        def collapse_repl(m):
            full = m.group(0).replace(' ', '')
            return full
        text = re.sub(pattern, collapse_repl, text)
        return text

    def _normalize_symbols(self, text: str) -> str:
        """Normalize special symbols."""
        text = text.replace('№', 'номер ')
        text = text.replace('&', ' и ')
        return text

    def _normalize_dates(self, text: str) -> str:
        """Normalize date patterns."""
        # Full date with year: 15.02.2026 г. or 15.02.2026
        pattern = r'\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})\s*г\.?'
        text = re.sub(pattern, lambda m: normalize_date(
            int(m.group(1)), int(m.group(2)), int(m.group(3)), include_year_suffix=True
        ), text)

        # Full date without г.: 15.02.2026
        pattern = r'\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})\b'
        text = re.sub(pattern, lambda m: normalize_date(
            int(m.group(1)), int(m.group(2)), int(m.group(3))
        ), text)

        # Partial date: 15.02 or 15/02 (day.month, no year)
        # Only match if not part of a longer number or followed by currency/unit
        pattern = r'\b(\d{1,2})[./](\d{1,2})\b(?!\.\d)(?!\s*(?:лв|лева|евро|долар|EUR|USD|BGN|GBP|%|ч\.|часа))'
        def partial_date_repl(m):
            day, month = int(m.group(1)), int(m.group(2))
            if 1 <= day <= 31 and 1 <= month <= 12:
                return normalize_date(day, month)
            return m.group(0)
        text = re.sub(pattern, partial_date_repl, text)

        # Date with month name: "15 май", "1 Януари 2026 г."
        month_names_pattern = '|'.join(MONTH_NAMES.values())
        month_name_to_num = {name.lower(): num for num, name in MONTH_NAMES.items()}

        # With year: "15 май 2026 г." or "15 май 2026"
        pattern = r'\b(\d{1,2})\s+(' + month_names_pattern + r')\s+(\d{4})\s*(г\.?)?'
        def month_name_year_repl(m):
            day = int(m.group(1))
            month = month_name_to_num[m.group(2).lower()]
            year = int(m.group(3))
            has_suffix = m.group(4) is not None
            if 1 <= day <= 31:
                return normalize_date(day, month, year, include_year_suffix=has_suffix)
            return m.group(0)
        text = re.sub(pattern, month_name_year_repl, text, flags=re.IGNORECASE)

        # Without year: "15 май"
        pattern = r'\b(\d{1,2})\s+(' + month_names_pattern + r')\b'
        def month_name_repl(m):
            day = int(m.group(1))
            month = month_name_to_num[m.group(2).lower()]
            if 1 <= day <= 31:
                return normalize_date(day, month)
            return m.group(0)
        text = re.sub(pattern, month_name_repl, text, flags=re.IGNORECASE)

        return text

    def _normalize_times(self, text: str) -> str:
        """Normalize time patterns."""
        # Time with ч./часа: 14:30 ч. or 14:30 часа
        pattern = r'\b(\d{1,2}):(\d{2})\s*(?:ч\.|часа|часът)'
        text = re.sub(pattern, lambda m: normalize_time(
            int(m.group(1)), int(m.group(2)), include_suffix=True
        ), text)

        # Standalone time: 14:30
        pattern = r'\b(\d{1,2}):(\d{2})\b'
        text = re.sub(pattern, lambda m: normalize_time(
            int(m.group(1)), int(m.group(2))
        ), text)

        return text

    def _normalize_currency(self, text: str) -> str:
        """Normalize currency patterns."""
        # Bulgarian Lev: 1500.50 лв. or 1500,50 лв or 1500 лв.
        # Vendored change: `лв\.?` then `\b` backtracked off the dot whenever punctuation followed,
        # leaving "стотинки.," — the dot is now consumed explicitly.
        pattern = r'\b(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:лв\.|(?:лв|лева|BGN)\b)'
        text = re.sub(pattern, lambda m: normalize_currency(
            m.group(1).replace(' ', ''), 'BGN'
        ), text)

        # Euro: €50, 50 EUR, 50 евро
        pattern = r'€\s*(\d[\d\s]*(?:[.,]\d{1,2})?)\s*'
        text = re.sub(pattern, lambda m: normalize_currency(
            m.group(1).replace(' ', ''), 'EUR'
        ) + ' ', text)
        pattern = r'\b(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:EUR|евро)\b'
        text = re.sub(pattern, lambda m: normalize_currency(
            m.group(1).replace(' ', ''), 'EUR'
        ), text)

        # USD: $50, 50 USD, 50 долара
        pattern = r'\$\s*(\d[\d\s]*(?:[.,]\d{1,2})?)\s*'
        text = re.sub(pattern, lambda m: normalize_currency(
            m.group(1).replace(' ', ''), 'USD'
        ) + ' ', text)
        pattern = r'\b(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:USD|долара?)\b'
        text = re.sub(pattern, lambda m: normalize_currency(
            m.group(1).replace(' ', ''), 'USD'
        ), text)

        return text

    def _normalize_percentages(self, text: str) -> str:
        """Normalize percentage patterns."""
        pattern = r'\b(\d+(?:[.,]\d+)?)\s*%'
        def pct_repl(m):
            num_str = m.group(1).replace(',', '.')
            if '.' in num_str:
                return float_to_words(num_str) + ' процента'
            else:
                return number_to_words_cardinal(int(num_str)) + ' процента'
        text = re.sub(pattern, pct_repl, text)
        return text

    def _normalize_phones(self, text: str) -> str:
        """Normalize phone number patterns."""
        # Bulgarian phone: +359 2 1234567, 0888 123 456, 02/1234567
        pattern = r'(?:\+359[\s\-]?|0)[\d\s\-/]{6,12}\d'
        text = re.sub(pattern, lambda m: normalize_phone_number(m.group(0)), text)
        return text

    def _normalize_roman_numerals(self, text: str) -> str:
        """Normalize Roman numerals to ordinal words."""
        # Roman numerals typically used for centuries, monarchs, chapters
        # Full pattern: M{0,3} CD/D?C{0,3} XC/XL/L?X{0,3} IX/IV/V?I{0,3}
        roman_pattern = r'(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})'
        context_words = r'век|глава|том|книга|част|клас|степен'
        feminine_words = {'глава', 'книга', 'част', 'степен'}

        def _roman_to_ordinal(roman: str, context: str) -> str:
            if not roman:
                return None
            arabic = roman_to_arabic(roman)
            if arabic is None:
                return None
            gender = 'f' if context.lower() in feminine_words else 'm'
            return number_to_words_ordinal(arabic, gender=gender)

        # Pattern 1: context word THEN Roman numeral (e.g., "век XXI")
        pattern = r'\b(' + context_words + r')\s+(' + roman_pattern + r')\b'
        def roman_repl(m):
            ordinal = _roman_to_ordinal(m.group(2), m.group(1))
            if ordinal is None:
                return m.group(0)
            return f'{m.group(1)} {ordinal}'
        text = re.sub(pattern, roman_repl, text, flags=re.IGNORECASE)

        # Pattern 2: Roman numeral THEN context word (e.g., "XXI век")
        pattern = r'\b(' + roman_pattern + r')\s+(' + context_words + r')\b'
        def roman_repl_reversed(m):
            ordinal = _roman_to_ordinal(m.group(1), m.group(2))
            if ordinal is None:
                return m.group(0)
            return f'{ordinal} {m.group(2)}'
        text = re.sub(pattern, roman_repl_reversed, text, flags=re.IGNORECASE)

        return text

    def _normalize_ordinals(self, text: str) -> str:
        """Normalize ordinal number patterns like 1-ви, 2-ри, 3-ти, 1-ва."""
        pattern = r'\b(\d+)\s*-?\s*(ви|ри|ти|ми|ва|ра|та|на|во|ро|то|но)\b'
        def ordinal_repl(m):
            num = int(m.group(1))
            suffix = m.group(2).lower()
            # Determine gender from suffix
            if suffix in ('ва', 'ра', 'та', 'на'):
                gender = 'f'
            elif suffix in ('во', 'ро', 'то', 'но'):
                gender = 'n'
            else:
                gender = 'm'
            return number_to_words_ordinal(num, gender=gender)
        text = re.sub(pattern, ordinal_repl, text)
        return text

    def _normalize_standalone_years(self, text: str) -> str:
        """Normalize 4-digit years that appear in year-like contexts."""
        # Year with г./година: 2026 г., 1989 година
        # Do NOT match "години" (plural) — that means "years" as duration, not a year label
        pattern = r'\b(\d{4})\s*(г\.|година)(?!и)'
        def year_repl(m):
            year = int(m.group(1))
            suffix = m.group(2)
            if 1000 <= year <= 2100:
                return normalize_year(year) + ' година'
            return m.group(0)
        text = re.sub(pattern, year_repl, text)
        return text

    def _normalize_cardinal_numbers(self, text: str) -> str:
        """Normalize remaining standalone numbers to cardinal words."""
        # Decimal numbers: 3.14, 1,5
        pattern = r'\b(\d+)[.,](\d+)\b'
        def decimal_repl(m):
            whole = m.group(1)
            frac = m.group(2)
            num_str = f"{whole}.{frac}"
            try:
                return float_to_words(num_str)
            except (ValueError, KeyError):
                return m.group(0)
        text = re.sub(pattern, decimal_repl, text)

        # Integer numbers
        pattern = r'\b(\d+)\b'
        def cardinal_repl(m):
            num = int(m.group(1))
            if num > 999999999999:  # Skip very large numbers
                return m.group(0)
            try:
                return number_to_words_cardinal(num)
            except (ValueError, KeyError):
                return m.group(0)
        text = re.sub(pattern, cardinal_repl, text)

        return text


_default_normalizer = None


def normalize_text(text: str, **kwargs) -> str:
    """Convenience function for quick normalization."""
    global _default_normalizer
    if kwargs:
        return BulgarianTextNormalizer(**kwargs).normalize(text)
    if _default_normalizer is None:
        _default_normalizer = BulgarianTextNormalizer()
    return _default_normalizer.normalize(text)
