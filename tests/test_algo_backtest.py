"""Run: python -m unittest discover -s tests -p 'test_algo*.py'"""
import unittest
from datetime import date, timedelta
from algo.backtest import Bar, Config, backtest, sma

class AlgoBacktestTests(unittest.TestCase):
    def bars(self, closes):
        start = date(2024,1,1)
        return [Bar((start+timedelta(days=i)).isoformat(), float(x), float(x)) for i,x in enumerate(closes)]

    def test_sma_warmup(self):
        self.assertEqual(sma([1,2,3,4], 3), [None,None,2.0,3.0])

    def test_no_future_leakage_or_same_bar_fill(self):
        values = [100,100,100,100,100,110,115,120,125,130]
        result = backtest(self.bars(values), Config(fast=2,slow=3))
        self.assertTrue(result["fills"])
        self.assertEqual(result["fills"][0]["side"], "BUY")
        # Up-cross detected at index 5; first possible fill at index 6.
        self.assertEqual(result["fills"][0]["time"], self.bars(values)[6].time)

    def test_empty_signals_preserve_capital(self):
        out=backtest(self.bars([100]*20),Config(fast=2,slow=3))
        self.assertEqual(out["end_equity"],10000)
        self.assertEqual(out["fills"],[])

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            backtest(self.bars([1]*10),Config(fast=4,slow=3))
        with self.assertRaises(ValueError):
            backtest(self.bars([1]*10),Config(fast=2,slow=3,allocation=1.2))
        with self.assertRaises(ValueError):
            backtest(self.bars([1,2,0,4,5]),Config(fast=2,slow=3))

if __name__ == "__main__":
    unittest.main()
