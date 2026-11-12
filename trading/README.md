# AGULA Paper Bot (first implementation)

This module provides a **local trading simulation**. No brokerage integration or real-money trading is enabled. It is a first step toward AGULA's future `ALGO`, `BACKTEST`, `RISK`, and `TRADE` modules, not a production trading service.

## Install and run

At repository root:

```bash
pip install -r requirements.txt
python -m trading.paper_bot --symbol SPY
python -m trading.paper_bot --symbol SPY --execute-paper --db agula_paper.sqlite3
python -m unittest discover -s tests -v
```

The default run is a **dry run** (signal only). `--execute-paper` records simulated fills locally in SQLite. Repeat the command to evaluate later daily bars. You should **not run this unattended**: it is not a scheduler, exchange simulator, or broker adapter.

Optional flags: `--fast 20 --slow 50 --capital 10000 --max-allocation 0.10 --max-drawdown 0.05 --fee 0`.

## Rules and limitations

- Strategy: confirmed 20/50 daily simple-moving-average crossover, based on historical `yfinance` data.
- Long only, one symbol per SQLite file, no short sales, no leverage; trade only on an explicit crossover.
- Only the latest bar is used as an *approximate* paper fill price. It may be partial, delayed, or stale. This is **not** a realistic fill model.
- Position size is limited by available cash and the maximum allocation (10% by default).
- Drawdown above 5% halts all orders, including exits: manual intervention is needed to resolve a halt. This MVP does **not** offer broker-side stop orders.
- Each crossover is keyed by symbol, completed bar date and MA parameters to prevent duplicate fills.
- Cash, positions and fills persist in a local SQLite database. Do not reuse the same file across different symbols or multiple concurrent bot processes.
- No commission unless `--fee` is specified; no spreads, slippage, dividends, market calendar, account reconciliation, data validity SLA or corporate action handling.
- No live API credentials are needed or accepted.

**Known gap:** do not interpret the risk parameters as a guaranteed maximum loss. Prices can gap, data can fail, and signals can arrive too late. For actual paper broker execution, the next upgrade should add Alpaca's paper API with robust fill reconciliation, data freshness checks, a separate continuously running worker, signed-in owner-only endpoints, and explicit paper/live isolation.

The public web server, Cloudflare deployment and the generated `agula.py` have not been modified, so this module runs via CLI separately from the existing AGULA UI.
