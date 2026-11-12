"""AGULA experimental local paper bot. Never connects to a live brokerage account.

Run: python -m trading.paper_bot --symbol SPY
Add --execute-paper to persist SIMULATED fills in a local SQLite database.
Not suitable for live trading. Quotes may be delayed.
"""
from __future__ import annotations

import argparse
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def sma(values: list[float], window: int) -> float:
    if window < 1 or len(values) < window:
        raise ValueError("insufficient observations")
    return sum(values[-window:]) / window


def crossover_signal(closes: list[float], fast: int = 20, slow: int = 50) -> str:
    """Return BUY/SELL only on a confirmed crossover; otherwise HOLD."""
    if not 1 <= fast < slow:
        raise ValueError("require 1 <= fast < slow")
    if len(closes) < slow + 1:
        raise ValueError("insufficient bars for crossover")
    previous_fast = sma(closes[:-1], fast)
    previous_slow = sma(closes[:-1], slow)
    current_fast = sma(closes, fast)
    current_slow = sma(closes, slow)
    if previous_fast <= previous_slow and current_fast > current_slow:
        return "BUY"
    if previous_fast >= previous_slow and current_fast < current_slow:
        return "SELL"
    return "HOLD"


class PaperAccount:
    """Single-symbol, long-only simulated account with durable fills and de-duplication."""

    def __init__(self, path: str, initial_cash: float):
        if not math.isfinite(initial_cash) or initial_cash <= 0:
            raise ValueError("initial_cash must be positive and finite")
        self.connection = sqlite3.connect(path, timeout=30)
        self.connection.execute("PRAGMA busy_timeout = 30000")
        self.connection.execute("""CREATE TABLE IF NOT EXISTS account (
            id INTEGER PRIMARY KEY CHECK(id=1), cash REAL NOT NULL,
            peak_equity REAL NOT NULL, halted INTEGER NOT NULL DEFAULT 0)""")
        self.connection.execute("""CREATE TABLE IF NOT EXISTS positions (
            symbol TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK(quantity >= 0))""")
        self.connection.execute("""CREATE TABLE IF NOT EXISTS fills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_id TEXT UNIQUE NOT NULL, timestamp TEXT NOT NULL,
            symbol TEXT NOT NULL, side TEXT NOT NULL, quantity INTEGER NOT NULL,
            price REAL NOT NULL, fee REAL NOT NULL)""")
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO account(id,cash,peak_equity,halted) VALUES(1,?,?,0)",
                (initial_cash, initial_cash),
            )

    def close(self) -> None:
        self.connection.close()

    def status(self, symbol: str, price: float, max_drawdown: float) -> dict:
        if not math.isfinite(price) or price <= 0:
            raise ValueError("price must be positive and finite")
        if not 0 < max_drawdown < 1:
            raise ValueError("max_drawdown must be between zero and one")
        with self.connection:
            cash, peak, halted = self.connection.execute(
                "SELECT cash,peak_equity,halted FROM account WHERE id=1"
            ).fetchone()
            row = self.connection.execute(
                "SELECT quantity FROM positions WHERE symbol=?", (symbol,)
            ).fetchone()
            quantity = row[0] if row else 0
            # This simple MVP values only the selected symbol. Never trade another
            # symbol using the same database.
            equity = cash + quantity * price
            peak = max(peak, equity)
            drawdown = max(0.0, 1 - equity / peak)
            halted = int(bool(halted) or drawdown >= max_drawdown)
            self.connection.execute(
                "UPDATE account SET peak_equity=?,halted=? WHERE id=1", (peak, halted)
            )
        return dict(cash=cash, quantity=quantity, equity=equity,
                    drawdown=drawdown, halted=bool(halted))

    def execute(self, *, symbol: str, signal: str, signal_id: str,
                price: float, max_allocation: float = 0.10,
                fee: float = 0.0, max_drawdown: float = 0.05) -> dict:
        if signal not in ("BUY", "SELL", "HOLD"):
            raise ValueError("invalid signal")
        if not 0 < max_allocation <= 1 or fee < 0 or not math.isfinite(fee):
            raise ValueError("invalid allocation or fee")
        snapshot = self.status(symbol, price, max_drawdown)
        if signal == "HOLD":
            return dict(action="HOLD", **snapshot)
        with self.connection:
            if self.connection.execute(
                "SELECT 1 FROM fills WHERE signal_id=?", (signal_id,)
            ).fetchone():
                return dict(action="DUPLICATE", **snapshot)
            cash, quantity = snapshot["cash"], snapshot["quantity"]
            if snapshot["halted"]:
                return dict(action="HALTED", **snapshot)
            if signal == "BUY":
                if quantity:
                    return dict(action="ALREADY_LONG", **snapshot)
                budget = min(cash - fee, snapshot["equity"] * max_allocation - fee)
                units = max(0, int(budget // price))
            else:
                units = quantity
            if units < 1 or (signal == "SELL" and units * price <= fee):
                return dict(action="NO_ORDER", **snapshot)
            cash += (-units * price - fee) if signal == "BUY" else (units * price - fee)
            quantity += units if signal == "BUY" else -units
            self.connection.execute(
                "UPDATE account SET cash=? WHERE id=1", (cash,)
            )
            self.connection.execute(
                "INSERT INTO positions(symbol,quantity) VALUES(?,?) "
                "ON CONFLICT(symbol) DO UPDATE SET quantity=excluded.quantity",
                (symbol, quantity),
            )
            self.connection.execute(
                "INSERT INTO fills(signal_id,timestamp,symbol,side,quantity,price,fee) "
                "VALUES(?,?,?,?,?,?,?)",
                (signal_id, datetime.now(timezone.utc).isoformat(),
                 symbol, signal, units, price, fee),
            )
        return dict(action=signal, units=units, cash=cash, quantity=quantity,
                    equity=cash + quantity * price)


def fetch_signal(symbol: str, fast: int, slow: int) -> tuple[str, str, float]:
    """Use completed historical daily bars for signals; approximate paper fill
    at the latest available daily price, NOT a broker-confirmed executable quote."""
    import yfinance as yf

    frame = yf.Ticker(symbol).history(period="2y", interval="1d", auto_adjust=True)
    if frame.empty or len(frame) < slow + 2:
        raise RuntimeError("insufficient market data")
    # Exclude the latest daily bar because it can be a partial trading session.
    completed = frame.iloc[:-1]
    closes = [float(x) for x in completed["Close"].tolist()]
    if not all(math.isfinite(x) and x > 0 for x in closes):
        raise RuntimeError("invalid market data")
    signal = crossover_signal(closes, fast, slow)
    bar = completed.index[-1].strftime("%Y-%m-%d")
    price = float(frame["Close"].iloc[-1])
    if not math.isfinite(price) or price <= 0:
        raise RuntimeError("invalid latest price")
    return signal, bar, price


def main() -> None:
    parser = argparse.ArgumentParser(description="AGULA local simulated paper bot")
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--fast", type=int, default=20)
    parser.add_argument("--slow", type=int, default=50)
    parser.add_argument("--capital", type=float, default=10000)
    parser.add_argument("--max-allocation", type=float, default=0.10)
    parser.add_argument("--max-drawdown", type=float, default=0.05)
    parser.add_argument("--fee", type=float, default=0.0)
    parser.add_argument("--db", default="agula_paper.sqlite3")
    parser.add_argument("--execute-paper", action="store_true",
                        help="Persist simulated fills locally; NEVER sends real orders")
    args = parser.parse_args()
    if not 1 <= args.fast < args.slow:
        parser.error("require 1 <= fast < slow")
    if not 0 < args.max_allocation <= 1 or not 0 < args.max_drawdown < 1:
        parser.error("allocation and drawdown limits must be within (0, 1]")
    if args.capital <= 0 or not math.isfinite(args.capital):
        parser.error("capital must be positive")
    if not args.symbol.isascii() or not args.symbol.replace("-", "").replace(".", "").isalnum():
        parser.error("invalid symbol")
    symbol = args.symbol.upper()
    signal, bar, price = fetch_signal(symbol, args.fast, args.slow)
    print(f"{symbol}: completed bar={bar} signal={signal} approximate_price={price:.4f}")
    if not args.execute_paper:
        print("DRY RUN: no fill recorded; use --execute-paper for local simulated fills.")
        return
    if Path(args.db).exists() and Path(args.db).is_dir():
        parser.error("database must be a file path")
    account = PaperAccount(args.db, args.capital)
    try:
        print(account.execute(
            symbol=symbol, signal=signal, signal_id=f"{symbol}:{bar}:{args.fast}:{args.slow}",
            price=price, max_allocation=args.max_allocation,
            max_drawdown=args.max_drawdown, fee=args.fee,
        ))
    finally:
        account.close()


if __name__ == "__main__":
    main()
