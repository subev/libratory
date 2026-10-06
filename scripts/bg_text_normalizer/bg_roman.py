"""
Roman Numeral Conversion
==========================
Converts Roman numerals to Arabic numbers for further processing.
"""

from typing import Optional

ROMAN_VALUES = {
    'I': 1, 'V': 5, 'X': 10, 'L': 50,
    'C': 100, 'D': 500, 'M': 1000,
}


def roman_to_arabic(roman: str) -> Optional[int]:
    """
    Convert a Roman numeral string to an integer.

    Args:
        roman: Roman numeral string (e.g., "XIV", "XXI")

    Returns:
        Integer value, or None if invalid
    """
    if not roman:
        return None

    roman = roman.upper().strip()

    # Validate characters
    for c in roman:
        if c not in ROMAN_VALUES:
            return None

    result = 0
    prev_value = 0

    for c in reversed(roman):
        value = ROMAN_VALUES[c]
        if value < prev_value:
            result -= value
        else:
            result += value
        prev_value = value

    if result <= 0:
        return None

    return result


if __name__ == '__main__':
    test_romans = ['I', 'II', 'III', 'IV', 'V', 'IX', 'X',
                   'XIV', 'XIX', 'XX', 'XXI', 'L', 'C', 'D', 'M']

    print("=== Roman Numerals ===")
    for r in test_romans:
        print(f"  {r} → {roman_to_arabic(r)}")
