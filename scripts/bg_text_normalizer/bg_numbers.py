"""
Bulgarian Number-to-Words Conversion
=====================================
Converts numbers to their Bulgarian word representation.
Handles cardinal numbers, ordinal numbers, and decimal numbers.
Supports grammatical gender (masculine, feminine, neuter).

Bulgarian number system specifics:
- Gender agreement: един/една/едно (one), два/две (two)
- Special forms for hundreds: сто, двеста, триста, четиристотин...
- "и" conjunction between parts
- Ordinal suffixes depend on gender
"""

# === Digit words for fallback digit-by-digit reading ===

DIGIT_WORDS = {
    '0': 'нула', '1': 'едно', '2': 'две', '3': 'три', '4': 'четири',
    '5': 'пет', '6': 'шест', '7': 'седем', '8': 'осем', '9': 'девет',
}

# === Cardinal number components ===

ONES_M = {
    0: '', 1: 'един', 2: 'два', 3: 'три', 4: 'четири', 5: 'пет',
    6: 'шест', 7: 'седем', 8: 'осем', 9: 'девет',
}

ONES_F = {
    0: '', 1: 'една', 2: 'две', 3: 'три', 4: 'четири', 5: 'пет',
    6: 'шест', 7: 'седем', 8: 'осем', 9: 'девет',
}

ONES_N = {
    0: '', 1: 'едно', 2: 'две', 3: 'три', 4: 'четири', 5: 'пет',
    6: 'шест', 7: 'седем', 8: 'осем', 9: 'девет',
}

TEENS = {
    10: 'десет', 11: 'единадесет', 12: 'дванадесет', 13: 'тринадесет',
    14: 'четиринадесет', 15: 'петнадесет', 16: 'шестнадесет',
    17: 'седемнадесет', 18: 'осемнадесет', 19: 'деветнадесет',
}

TENS = {
    2: 'двадесет', 3: 'тридесет', 4: 'четиридесет', 5: 'петдесет',
    6: 'шестдесет', 7: 'седемдесет', 8: 'осемдесет', 9: 'деветдесет',
}

HUNDREDS = {
    1: 'сто', 2: 'двеста', 3: 'триста', 4: 'четиристотин',
    5: 'петстотин', 6: 'шестстотин', 7: 'седемстотин',
    8: 'осемстотин', 9: 'деветстотин',
}

# === Ordinal number components ===

ORDINAL_ONES_M = {
    1: 'първи', 2: 'втори', 3: 'трети', 4: 'четвърти', 5: 'пети',
    6: 'шести', 7: 'седми', 8: 'осми', 9: 'девети', 10: 'десети',
}
ORDINAL_ONES_F = {
    1: 'първа', 2: 'втора', 3: 'трета', 4: 'четвърта', 5: 'пета',
    6: 'шеста', 7: 'седма', 8: 'осма', 9: 'девета', 10: 'десета',
}
ORDINAL_ONES_N = {
    1: 'първо', 2: 'второ', 3: 'трето', 4: 'четвърто', 5: 'пето',
    6: 'шесто', 7: 'седмо', 8: 'осмо', 9: 'девето', 10: 'десето',
}

ORDINAL_TEENS_M = {
    11: 'единадесети', 12: 'дванадесети', 13: 'тринадесети',
    14: 'четиринадесети', 15: 'петнадесети', 16: 'шестнадесети',
    17: 'седемнадесети', 18: 'осемнадесети', 19: 'деветнадесети',
}
ORDINAL_TEENS_F = {
    11: 'единадесета', 12: 'дванадесета', 13: 'тринадесета',
    14: 'четиринадесета', 15: 'петнадесета', 16: 'шестнадесета',
    17: 'седемнадесета', 18: 'осемнадесета', 19: 'деветнадесета',
}
ORDINAL_TEENS_N = {
    11: 'единадесето', 12: 'дванадесето', 13: 'тринадесето',
    14: 'четиринадесето', 15: 'петнадесето', 16: 'шестнадесето',
    17: 'седемнадесето', 18: 'осемнадесето', 19: 'деветнадесето',
}

ORDINAL_TENS_M = {
    2: 'двадесети', 3: 'тридесети', 4: 'четиридесети', 5: 'петдесети',
    6: 'шестдесети', 7: 'седемдесети', 8: 'осемдесети', 9: 'деветдесети',
}
ORDINAL_TENS_F = {
    2: 'двадесета', 3: 'тридесета', 4: 'четиридесета', 5: 'петдесета',
    6: 'шестдесета', 7: 'седемдесета', 8: 'осемдесета', 9: 'деветдесета',
}
ORDINAL_TENS_N = {
    2: 'двадесето', 3: 'тридесето', 4: 'четиридесето', 5: 'петдесето',
    6: 'шестдесето', 7: 'седемдесето', 8: 'осемдесето', 9: 'деветдесето',
}

ORDINAL_HUNDREDS_M = {
    1: 'стотен', 2: 'двестотен', 3: 'тристотен', 4: 'четиристотен',
    5: 'петстотен', 6: 'шестстотен', 7: 'седемстотен',
    8: 'осемстотен', 9: 'деветстотен',
}
ORDINAL_HUNDREDS_F = {
    1: 'стотна', 2: 'двестотна', 3: 'тристотна', 4: 'четиристотна',
    5: 'петстотна', 6: 'шестстотна', 7: 'седемстотна',
    8: 'осемстотна', 9: 'деветстотна',
}
ORDINAL_HUNDREDS_N = {
    1: 'стотно', 2: 'двестотно', 3: 'тристотно', 4: 'четиристотно',
    5: 'петстотно', 6: 'шестстотно', 7: 'седемстотно',
    8: 'осемстотно', 9: 'деветстотно',
}


def _get_ones(gender: str = 'm'):
    """Get the ones dictionary for the specified gender."""
    if gender == 'f':
        return ONES_F
    elif gender == 'n':
        return ONES_N
    return ONES_M


def _cardinal_under_1000(n: int, gender: str = 'm') -> str:
    """Convert a number 0-999 to Bulgarian cardinal words."""
    if n == 0:
        return ''

    ones = _get_ones(gender)
    parts = []

    hundreds = n // 100
    remainder = n % 100

    if hundreds > 0:
        parts.append(HUNDREDS[hundreds])

    if remainder == 0:
        pass
    elif remainder < 10:
        if hundreds > 0:
            parts.append('и')
        parts.append(ones[remainder])
    elif remainder < 20:
        if hundreds > 0:
            parts.append('и')
        parts.append(TEENS[remainder])
    else:
        tens_digit = remainder // 10
        ones_digit = remainder % 10
        if hundreds > 0 and ones_digit == 0:
            parts.append('и')
        parts.append(TENS[tens_digit])
        if ones_digit > 0:
            parts.append('и')
            parts.append(ones[ones_digit])

    return ' '.join(parts)


def number_to_words_cardinal(n: int, gender: str = 'm') -> str:
    """
    Convert an integer to Bulgarian cardinal words.

    Args:
        n: The number to convert (0 to 999,999,999,999)
        gender: Grammatical gender - 'm' (masculine), 'f' (feminine), 'n' (neuter)
                Gender only affects 1 and 2.

    Returns:
        Bulgarian word representation of the number.
    """
    if n == 0:
        return 'нула'

    if n < 0:
        return 'минус ' + number_to_words_cardinal(-n, gender)

    if n > 999_999_999_999:
        return ' '.join(DIGIT_WORDS.get(d, d) for d in str(n))

    parts = []

    # Billions (милиарди)
    billions = n // 1_000_000_000
    n %= 1_000_000_000
    if billions > 0:
        if billions == 1:
            parts.append('един милиард')
        elif billions == 2:
            parts.append('два милиарда')
        else:
            parts.append(_cardinal_under_1000(billions, 'm') + ' милиарда')

    # Millions (милиони)
    millions = n // 1_000_000
    n %= 1_000_000
    if millions > 0:
        if millions == 1:
            parts.append('един милион')
        elif millions == 2:
            parts.append('два милиона')
        else:
            parts.append(_cardinal_under_1000(millions, 'm') + ' милиона')

    # Thousands (хиляди)
    thousands = n // 1000
    n %= 1000
    if thousands > 0:
        if thousands == 1:
            parts.append('хиляда')
        elif thousands == 2:
            parts.append('две хиляди')
        else:
            # Хиляди is feminine, so use feminine gender for the number
            parts.append(_cardinal_under_1000(thousands, 'f') + ' хиляди')

    # Remainder (0-999) — use the requested gender
    if n > 0:
        remainder_str = _cardinal_under_1000(n, gender)
        if parts:
            # Add "и" before small remainders, or before hundreds when
            # there are no tens/ones
            if n < 100:
                parts.append('и ' + remainder_str)
            elif n % 100 == 0:
                # e.g., 2500 → две хиляди и петстотин
                parts.append('и ' + remainder_str)
            else:
                parts.append(remainder_str)
        else:
            parts.append(remainder_str)

    return ' '.join(parts)


def number_to_words_ordinal(n: int, gender: str = 'm') -> str:
    """
    Convert an integer to Bulgarian ordinal words.

    Args:
        n: The number to convert (1-9999+)
        gender: 'm' (masculine), 'f' (feminine), 'n' (neuter)

    Returns:
        Bulgarian ordinal word representation.
    """
    if n <= 0:
        return number_to_words_cardinal(n, gender)

    # For numbers with thousands+, we use cardinal for the leading part
    # and ordinal for the final component
    if n >= 1000:
        thousands = n // 1000
        remainder = n % 1000
        if remainder == 0:
            # e.g., 2000-та → двехилядна (feminine)
            # Build from cardinal of thousands
            if thousands == 1:
                base = 'хиляд'
            elif thousands == 2:
                base = 'двехиляд'
            else:
                base = _cardinal_under_1000(thousands, 'f') + 'хиляд'
            # Remove trailing space if any
            base = base.strip()
            if gender == 'f':
                return base + 'на'
            elif gender == 'n':
                return base + 'но'
            return base + 'ен'
        else:
            # e.g., 2026 → две хиляди двадесет и шести
            leading = number_to_words_cardinal(n - remainder, gender)
            trailing = number_to_words_ordinal(remainder, gender)
            return leading + ' ' + trailing

    if n >= 100:
        hundreds_digit = n // 100
        remainder = n % 100
        if remainder == 0:
            if gender == 'm':
                return ORDINAL_HUNDREDS_M.get(hundreds_digit, '')
            elif gender == 'f':
                return ORDINAL_HUNDREDS_F.get(hundreds_digit, '')
            else:
                return ORDINAL_HUNDREDS_N.get(hundreds_digit, '')
        else:
            return HUNDREDS[hundreds_digit] + ' ' + number_to_words_ordinal(remainder, gender)

    if n >= 20:
        tens_digit = n // 10
        ones_digit = n % 10
        if ones_digit == 0:
            if gender == 'm':
                return ORDINAL_TENS_M.get(tens_digit, '')
            elif gender == 'f':
                return ORDINAL_TENS_F.get(tens_digit, '')
            else:
                return ORDINAL_TENS_N.get(tens_digit, '')
        else:
            return TENS[tens_digit] + ' и ' + number_to_words_ordinal(ones_digit, gender)

    if 11 <= n <= 19:
        if gender == 'm':
            return ORDINAL_TEENS_M.get(n, '')
        elif gender == 'f':
            return ORDINAL_TEENS_F.get(n, '')
        else:
            return ORDINAL_TEENS_N.get(n, '')

    if 1 <= n <= 10:
        if gender == 'm':
            return ORDINAL_ONES_M.get(n, '')
        elif gender == 'f':
            return ORDINAL_ONES_F.get(n, '')
        else:
            return ORDINAL_ONES_N.get(n, '')

    return number_to_words_cardinal(n, gender)


def float_to_words(f, gender: str = 'n') -> str:
    """
    Convert a float or numeric string to Bulgarian words.
    E.g., 3.14 → "три цяло и четиринадесет стотни"
    For simple cases like 1.5 → "едно цяло и пет десети"

    Accepts float or string. String is preferred for precision.
    """
    # Use string-based parsing to avoid IEEE 754 artifacts
    if isinstance(f, str):
        s = f
    elif isinstance(f, float):
        s = f'{f:.10g}'
    else:
        s = str(f)
    s = s.replace(',', '.')

    if '.' not in s:
        return number_to_words_cardinal(int(s), gender)

    whole_str, decimal_str = s.split('.', 1)
    decimal_str = decimal_str.rstrip('0')

    whole = int(whole_str) if whole_str else 0

    if not decimal_str:
        return number_to_words_cardinal(whole, gender)

    decimal_val = int(decimal_str)
    decimal_places = len(decimal_str)

    # Whole part
    if whole == 0:
        result = 'нула'
    else:
        result = number_to_words_cardinal(whole, 'n')

    result += ' цяло и '

    # Decimal part with appropriate denomination
    decimal_words = number_to_words_cardinal(decimal_val, 'f')

    if decimal_places == 1:
        denom = 'десета' if decimal_val == 1 else 'десети'
    elif decimal_places == 2:
        denom = 'стотна' if decimal_val == 1 else 'стотни'
    elif decimal_places == 3:
        denom = 'хилядна' if decimal_val == 1 else 'хилядни'
    else:
        denom = ''

    result += decimal_words + ' ' + denom

    return result.strip()


if __name__ == '__main__':
    # Test cardinal numbers
    test_cardinals = [
        (0, 'm'), (1, 'm'), (1, 'f'), (1, 'n'), (2, 'm'), (2, 'f'),
        (10, 'm'), (11, 'm'), (15, 'm'), (20, 'm'), (21, 'm'), (21, 'f'),
        (100, 'm'), (101, 'm'), (200, 'm'), (256, 'm'), (999, 'm'),
        (1000, 'm'), (1001, 'm'), (1500, 'm'), (2000, 'm'), (2026, 'm'),
        (10000, 'm'), (100000, 'm'), (1000000, 'm'), (1234567, 'm'),
    ]

    print("=== Cardinal Numbers ===")
    for num, g in test_cardinals:
        print(f"  {num} ({g}): {number_to_words_cardinal(num, g)}")

    print("\n=== Ordinal Numbers ===")
    test_ordinals = [
        (1, 'm'), (1, 'f'), (2, 'm'), (3, 'm'), (5, 'f'),
        (10, 'm'), (11, 'm'), (15, 'f'), (20, 'm'), (21, 'm'),
        (100, 'm'), (256, 'm'),
    ]
    for num, g in test_ordinals:
        print(f"  {num} ({g}): {number_to_words_ordinal(num, g)}")

    print("\n=== Decimal Numbers ===")
    test_decimals = [3.14, 1.5, 0.25, 99.99, 1500.50]
    for num in test_decimals:
        print(f"  {num}: {float_to_words(num)}")
