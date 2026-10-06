"""
Bulgarian Phone Number Normalization
=======================================
Converts phone numbers to digit-by-digit spoken form.

Bulgarian phone formats:
- Mobile: 0888 123 456, 088 812 3456
- Landline: 02 123 4567, 032 12 34 56
- International: +359 888 123 456
"""

from .bg_numbers import number_to_words_cardinal, DIGIT_WORDS


def normalize_phone_number(phone: str) -> str:
    """
    Convert a phone number to spoken Bulgarian form.
    Reads digits in groups for natural speech rhythm.

    Args:
        phone: Phone number string, e.g., "+359 888 123 456"

    Returns:
        Spoken form with digits read in natural groups
    """
    # Clean up
    cleaned = phone.strip()

    # Handle international prefix
    prefix = ''
    if cleaned.startswith('+359'):
        prefix = 'плюс три пет девет '
        cleaned = cleaned[4:].strip()

    # Remove all non-digits
    digits_only = ''.join(c for c in cleaned if c.isdigit())

    if not digits_only:
        return phone

    # Group digits naturally based on Bulgarian phone conventions
    # Read as pairs or triples
    result_parts = []

    if prefix:
        result_parts.append(prefix.strip())

    # Read remaining digits in pairs
    i = 0
    while i < len(digits_only):
        remaining = len(digits_only) - i

        if remaining >= 2:
            pair = digits_only[i:i+2]
            pair_num = int(pair)
            if pair_num == 0:
                result_parts.append('нула нула')
            elif pair_num < 10:
                result_parts.append('нула ' + DIGIT_WORDS[pair[1]])
            else:
                result_parts.append(number_to_words_cardinal(pair_num))
            i += 2
        else:
            result_parts.append(DIGIT_WORDS[digits_only[i]])
            i += 1

    return ' '.join(result_parts)


if __name__ == '__main__':
    test_phones = [
        "+359 888 123 456",
        "0888 123 456",
        "02 1234567",
        "0888123456",
        "+359 2 981 5678",
    ]

    print("=== Phone Number Normalization ===")
    for phone in test_phones:
        result = normalize_phone_number(phone)
        print(f"  {phone} → {result}")
