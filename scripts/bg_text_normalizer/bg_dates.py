"""
Bulgarian Date Normalization
=============================
Converts date patterns to spoken Bulgarian form.

Bulgarian date specifics:
- Day is ordinal (masculine by default): "петнадесети"
- Month names: януари, февруари, март, etc.
- Year is read as cardinal: две хиляди двадесет и шеста
- "година" (year) suffix is common
"""

from .bg_numbers import number_to_words_ordinal, number_to_words_cardinal

MONTH_NAMES = {
    1: 'януари', 2: 'февруари', 3: 'март', 4: 'април',
    5: 'май', 6: 'юни', 7: 'юли', 8: 'август',
    9: 'септември', 10: 'октомври', 11: 'ноември', 12: 'декември',
}


def normalize_date(day: int, month: int, year: int = None,
                   include_year_suffix: bool = False) -> str:
    """
    Convert a date to spoken Bulgarian form.

    Args:
        day: Day of month (1-31)
        month: Month number (1-12)
        year: Optional year (e.g., 2026)
        include_year_suffix: Whether to append "година"

    Returns:
        Spoken form, e.g., "петнадесети февруари две хиляди двадесет и шеста година"
    """
    if month < 1 or month > 12:
        return f"{day}.{month}" + (f".{year}" if year else "")

    # Day as ordinal (masculine, since "ден" is masculine)
    day_word = number_to_words_ordinal(day, gender='m')

    # Month name
    month_word = MONTH_NAMES[month]

    parts = [day_word, month_word]

    if year is not None:
        year_word = normalize_year(year)
        parts.append(year_word)
        if include_year_suffix:
            parts.append('година')

    return ' '.join(parts)


def normalize_year(year: int) -> str:
    """
    Convert a year to spoken Bulgarian form.

    Bulgarian years are typically read as:
    - 2026 → "две хиляди двадесет и шеста" (ordinal feminine, since "година" is feminine)
    - 1989 → "хиляда деветстотин осемдесет и девета"
    - 2000 → "двехилядна" (ordinal feminine)
    - 1900 → "хиляда и деветстотна"

    For year context, the last component is typically ordinal feminine
    (agreeing with "година").
    """
    if year <= 0:
        return number_to_words_cardinal(year)

    # Use ordinal feminine since "година" is feminine
    return number_to_words_ordinal(year, gender='f')


if __name__ == '__main__':
    test_dates = [
        (15, 2, 2026, True),
        (1, 1, 2000, True),
        (3, 3, 1878, True),
        (25, 12, None, False),
        (31, 12, 1999, True),
        (1, 9, 2024, False),
    ]

    print("=== Date Normalization ===")
    for args in test_dates:
        day, month = args[0], args[1]
        year = args[2]
        suffix = args[3] if len(args) > 3 else False
        result = normalize_date(day, month, year, include_year_suffix=suffix)
        date_str = f"{day:02d}.{month:02d}"
        if year:
            date_str += f".{year}"
        if suffix:
            date_str += " г."
        print(f"  {date_str} → {result}")
