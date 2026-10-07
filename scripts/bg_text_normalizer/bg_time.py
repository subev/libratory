"""
Bulgarian Time Normalization
==============================
Converts time patterns to spoken Bulgarian form.

Bulgarian time specifics:
- 14:30 → "четиринадесет и тридесет"
- 14:30 ч. → "четиринадесет и тридесет часа"
- 9:05 → "девет и пет"
- 12:00 → "дванадесет часа"
- Bulgarian uses 24-hour format predominantly
"""

from .bg_numbers import number_to_words_cardinal


def normalize_time(hours: int, minutes: int, include_suffix: bool = False) -> str:
    """
    Convert time to spoken Bulgarian form.

    Args:
        hours: Hour (0-23)
        minutes: Minutes (0-59)
        include_suffix: Whether to append "часа"

    Returns:
        Spoken form, e.g., "четиринадесет и тридесет часа"
    """
    hours_word = number_to_words_cardinal(hours)

    if minutes == 0:
        result = hours_word
        if include_suffix:
            result += ' часа'
        return result

    minutes_word = number_to_words_cardinal(minutes)

    # In Bulgarian, time is read as "часове и минути"
    result = f"{hours_word} и {minutes_word}"

    if include_suffix:
        result += ' часа'

    return result
