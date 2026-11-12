"""Deterministic research-only SMA backtester for AGULA.

No network, broker connection, persistent state, or live-order capability.
Bars are ordered oldest to newest and signals execute on the NEXT bar's open.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from math import isfinite
from typing import Sequence


@dataclass(frozen=True)
class Bar:
    timestamp: str
    open: float
    close: float

    def __post_init__(self):
        try:
            datetime.fromisoformat(self.timestamp.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("timestamp must be ISO 8601") from exc
        if not all(isfinite(v) and v > 0 for v in (self.open, self.close)):
            raise ValueError("open and close must be positive finite numbers")


@dataclass(frozen=True)
class Settings:
    fast: int = 20
    slow: int = 50
    capital: float = 10000.0
    allocation: float = 0.10
    commission_bps: float = 1.0
    slippage_bps: float = 2.0

    def __post_init__(self):
        if not (isinstance(self.fast, int) and isinstance(self.slow, int) and 2 <= self.fast < self.slow):
            raise ValueError("Require integer moving averages: 2 <= fast < slow")
        if not (isfinite(self.capital) and self.capital > 0):
            raise ValueError("capital must be positive")
        if not (isfinite(self.allocation) and 0 < self.allocation <= 1):
            raise ValueError("allocation must be in (0, 1]")
        if any(not isfinite(x) or x < 0 or x >= 10000 for x in (self.commission_bps, self.slippage_bps)):
            raise ValueError("commission/slippage bps must be in [0, 10000)")


def sma(values: Sequence[float], period: int) -> list[float | None]:
    """Rolling simple mean; None until a full window is available."""
    result: list[float | None] = []
    total = 0.0
    for i, value in enumerate(values):
        total += value
        if i >= period:
            total -= values[i - period]
        result.append(total / period if i >= period - 1 else None)
    return result


def backtest(bars: Sequence[Bar], settings: Settings = Settings()) -> dict:
    """Long-only SMA crossover, next-open fills, no leverage or fractional shares.

    A signal at close[t] is only eligible to execute at open[t+1].
    Portfolio equity is marked at close[t]. Cash earns zero interest.
    Open positions are marked to market but not force-liquidated at the end.
    """
    if len(bars) <= settings.slow:
        raise ValueError("Need more bars than slow window for next-open fills")
    times = [datetime.fromisoformat(b.timestamp.replace("Z", "+00:00")) for b in bars]
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("bars must be strictly increasing with unique timestamps")
    closes = [b.close for b in bars]
    fast = sma(closes, settings.fast)
    slow = sma(closes, settings.slow)
    cash, shares = settings.capital, 0
    pending: str | None = None
    fills: list[dict] = []
    equity: list[dict] = []
    peak = settings.capital
    max_drawdown = 0.0
    bps = 10000.0

    for i, bar in enumerate(bars):
        # Execute the prior close's signal, not the current close's signal.
        if pending == "BUY" and shares == 0:
            fill_price = bar.open * (1 + settings.slippage_bps / bps)
            per_share_cost = fill_price * (1 + settings.commission_bps / bps)
            budget = min(cash, (cash + shares * bar.open) * settings.allocation)
            qty = max(0, int(budget / per_share_cost))
            if qty:
                cash -= qty * per_share_cost
                shares += qty
                fills.append({"timestamp": bar.timestamp, "side": "BUY", "quantity": qty,
                              "price": round(fill_price, 8), "commission": round(qty * fill_price * settings.commission_bps / bps, 8)})
        elif pending == "SELL" and shares:
            fill_price = bar.open * (1 - settings.slippage_bps / bps)
            qty = shares
            commission = qty * fill_price * settings.commission_bps / bps
            cash += qty * fill_price - commission
            shares = 0
            fills.append({"timestamp": bar.timestamp, "side": "SELL", "quantity": qty,
                          "price": round(fill_price, 8), "commission": round(commission, 8)})
        pending = None

        value = cash + shares * bar.close
        peak = max(peak, value)
        max_drawdown = max(max_drawdown, (peak - value) / peak)
        equity.append({"timestamp": bar.timestamp, "equity": round(value, 6)})

        # No look-ahead: only fully observed close prices generate the next signal.
        if i > 0 and fast[i - 1] is not None and slow[i - 1] is not None:
            crossed_up = fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]
            crossed_down = fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
            if crossed_up and shares == 0:
                pending = "BUY"
            elif crossed_down and shares > 0:
                pending = "SELL"

    ending = cash + shares * bars[-1].close
    return {
        "settings": asdict(settings),
        "start": bars[0].timestamp,
        "end": bars[-1].timestamp,
        "start_equity": settings.capital,
        "end_equity": round(ending, 6),
        "total_return_pct": round(100 * (ending / settings.capital - 1), 6),
        "max_drawdown_pct": round(100 * max_drawdown, 6),
        "cash": round(cash, 6),
        "open_shares": shares,
        "fills": fills,
        "equity_curve": equity,
        "unfilled_final_signal": pending,
        "mode": "historical_simulation_only",
    }
