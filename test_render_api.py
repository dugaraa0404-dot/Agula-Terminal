"""Basic validation smoke tests. Run with the repo's dependencies installed."""
import unittest
from fastapi import HTTPException
# When the overlay is tested without the upstream repository, stub only the
# dependency import; deployed AGULA uses its real trading.paper_bot module.
try:
    import trading.paper_bot
except ModuleNotFoundError:
    import sys, types
    trading = types.ModuleType('trading')
    trading.__path__ = []
    bot = types.ModuleType('trading.paper_bot')
    bot.PaperAccount = object
    bot.fetch_signal = lambda *args: ("HOLD", "2026-01-01", 100.0)
    sys.modules['trading'] = trading
    sys.modules['trading.paper_bot'] = bot
from render.trading_api import normalize_symbol, validate_windows, authorize


class ValidationTests(unittest.TestCase):
    def test_good_symbol(self):
        self.assertEqual(normalize_symbol(' spy '), 'SPY')

    def test_invalid_symbol(self):
        with self.assertRaises(HTTPException):
            normalize_symbol('../private')

    def test_fast_must_be_less_than_slow(self):
        with self.assertRaises(HTTPException):
            validate_windows(50, 20)

    def test_writes_disabled_by_default(self):
        import os
        prior = os.environ.pop('AGULA_PAPER_TOKEN', None)
        try:
            with self.assertRaises(HTTPException) as exc:
                authorize(None)
            self.assertEqual(exc.exception.status_code, 503)
        finally:
            if prior is not None:
                os.environ['AGULA_PAPER_TOKEN'] = prior


if __name__ == '__main__':
    unittest.main()
