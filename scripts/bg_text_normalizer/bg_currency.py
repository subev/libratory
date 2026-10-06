"""
Bulgarian Currency Normalization
==================================
Converts currency amounts to spoken Bulgarian form.

Supported currencies:
- BGN (лева / стотинки)
- EUR (евро / цента)
- USD (долара / цента)
- GBP (лири / пенса)
"""

from .bg_numbers import number_to_words_cardinal

CURRENCY_INFO = {
    'BGN': {
        'main_singular': 'лев',
        'main_plural': 'лева',
        'sub_singular': 'стотинка',
        'sub_plural': 'стотинки',
        'main_gender': 'm',
        'sub_gender': 'f',
    },
    'EUR': {
        'main_singular': 'евро',
        'main_plural': 'евро',
        'sub_singular': 'цент',
        'sub_plural': 'цента',
        'main_gender': 'n',
        'sub_gender': 'm',
    },
    'USD': {
        'main_singular': 'долар',
        'main_plural': 'долара',
        'sub_singular': 'цент',
        'sub_plural': 'цента',
        'main_gender': 'm',
        'sub_gender': 'm',
    },
    'GBP': {
        'main_singular': 'лира',
        'main_plural': 'лири',
        'sub_singular': 'пени',
        'sub_plural': 'пенса',
        'main_gender': 'f',
        'sub_gender': 'm',
    },
}


def normalize_currency(amount_str: str, currency: str = 'BGN') -> str:
    """
    Convert a currency amount to spoken Bulgarian form.

    Args:
        amount_str: Amount as string, e.g., "1500.50", "1500,50", "25"
        currency: Currency code (BGN, EUR, USD, GBP)

    Returns:
        Spoken form, e.g., "хиляда и петстотин лева и петдесет стотинки"
    """
    currency = currency.upper()
    if currency not in CURRENCY_INFO:
        currency = 'BGN'

    info = CURRENCY_INFO[currency]

    # Parse amount using string-based approach to avoid float precision issues
    amount_str = amount_str.replace(',', '.').replace(' ', '')
    if '.' in amount_str:
        parts = amount_str.split('.', 1)
        try:
            main_amount = int(parts[0]) if parts[0] else 0
        except ValueError:
            return amount_str
        sub_str = (parts[1] + '00')[:2]
        sub_amount = int(sub_str)
    else:
        try:
            main_amount = int(amount_str)
        except ValueError:
            return amount_str
        sub_amount = 0

    parts = []

    # Main currency
    if main_amount > 0:
        main_words = number_to_words_cardinal(main_amount, info['main_gender'])
        main_unit = info['main_singular'] if main_amount == 1 else info['main_plural']
        parts.append(f"{main_words} {main_unit}")

    # Sub currency (stotinki, cents, etc.)
    if sub_amount > 0:
        if parts:
            parts.append('и')
        sub_words = number_to_words_cardinal(sub_amount, info['sub_gender'])
        sub_unit = info['sub_singular'] if sub_amount == 1 else info['sub_plural']
        parts.append(f"{sub_words} {sub_unit}")

    if not parts:
        return f"нула {info['main_plural']}"

    return ' '.join(parts)


if __name__ == '__main__':
    test_amounts = [
        ("1500.50", "BGN"),
        ("1", "BGN"),
        ("2", "BGN"),
        ("25", "BGN"),
        ("99.99", "BGN"),
        ("0.50", "BGN"),
        ("100", "EUR"),
        ("50.25", "USD"),
        ("1", "EUR"),
        ("1000000", "BGN"),
    ]

    print("=== Currency Normalization ===")
    for amount, currency in test_amounts:
        result = normalize_currency(amount, currency)
        print(f"  {amount} {currency} → {result}")
