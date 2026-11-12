# AGULA ALGO — first research foundation

This branch adds an **isolated, offline, research-only historical backtesting engine** in `algo/backtest.py`. It does not make trading orders and does not change the deployed terminal or any existing API endpoint.

## Execute the included tests

```bash
python -m unittest discover -s tests -p 'test_algo*.py' -v
```

## Run a local synthetic example

```python
from algo.backtest import Bar, Config, backtest
from datetime import date, timedelta
prices = [100]*5 + [110,115,120,125,130]
bars = [Bar((date(2024,1,1)+timedelta(days=i)).isoformat(),float(p),float(p)) for i,p in enumerate(prices)]
result = backtest(bars, Config(fast=2, slow=3))
print(result["fills"])
print(result["total_return_pct"])
```

## Deliberate limitations

- SMA signals are generated at bar close and trades fill at the next bar open. No same-bar execution.
- Long-only, integer shares, no leverage, one instrument, fixed allocation, basic fee/slippage assumptions.
- No survivorship-bias mitigation, exchange calendar, corporate-action adjustment, dividend handling, borrow fees, spread model, trade halts, liquidity model, or broker reconciliation.
- Historical backtests do not guarantee future outcomes.
- Nothing on this branch is a production or live-trading risk engine.

## Planned increments

1. Add authenticated `/api/algo/backtest` using validated bars and configuration; source historical prices from an explicit, licensed adapter.
2. Persist strategies, run histories, quotes and executions in PostgreSQL.
3. Add walk-forward evaluation, benchmarks, split/dividend corrections, paper trading via a broker adapter.
4. Deploy a separate always-on bot runner, independent from Cloudflare's idle-sleeping web container.
5. Add order reconciliation, exchange session checks, idempotent client order IDs, risk checks, and a tested kill switch before considering live orders.

**Do not store brokerage API secrets in source control or browser storage.**
