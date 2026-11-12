"""Run with: python -m unittest discover -s tests -v"""
import tempfile
import unittest
from pathlib import Path

from trading.paper_bot import PaperAccount, crossover_signal


class SignalTests(unittest.TestCase):
    def test_insufficient_bars(self):
        with self.assertRaises(ValueError):
            crossover_signal([1, 2, 3], 2, 3)

    def test_buy_crossover(self):
        self.assertEqual(crossover_signal([10, 10, 10, 9, 12], 2, 3), "BUY")

    def test_hold_flat(self):
        self.assertEqual(crossover_signal([10, 10, 10, 10], 2, 3), "HOLD")

    def test_invalid_windows(self):
        with self.assertRaises(ValueError):
            crossover_signal([1, 2, 3], 3, 2)


class PaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "paper.sqlite3")
        self.account = PaperAccount(self.db, 10000)

    def tearDown(self):
        self.account.close()
        self.temp.cleanup()

    def test_buy_and_deduplicate(self):
        first = self.account.execute(symbol="SPY", signal="BUY", signal_id="bar1", price=100)
        self.assertEqual(first["action"], "BUY")
        self.assertEqual(first["units"], 10)
        repeat = self.account.execute(symbol="SPY", signal="BUY", signal_id="bar1", price=100)
        self.assertEqual(repeat["action"], "DUPLICATE")
        self.assertEqual(self.account.status("SPY", 100, 0.05)["quantity"], 10)

    def test_sell_and_persistence(self):
        self.account.execute(symbol="SPY", signal="BUY", signal_id="bar1", price=100)
        self.assertEqual(self.account.execute(
            symbol="SPY", signal="SELL", signal_id="bar2", price=110
        )["quantity"], 0)
        self.account.close()
        self.account = PaperAccount(self.db, 999999)
        self.assertEqual(self.account.status("SPY", 110, 0.05)["cash"], 10100)

    def test_drawdown_halt(self):
        self.account.execute(symbol="SPY", signal="BUY", signal_id="bar1",
                             price=100, max_allocation=1.0)
        self.assertTrue(self.account.status("SPY", 90, 0.05)["halted"])
        self.assertEqual(self.account.execute(
            symbol="SPY", signal="BUY", signal_id="bar2", price=90
        )["action"], "HALTED")

    def test_no_live_broker(self):
        self.assertEqual(self.account.execute(
            symbol="SPY", signal="HOLD", signal_id="hold", price=100
        )["action"], "HOLD")


if __name__ == "__main__":
    unittest.main()
