"""AGULA research-only long-only SMA backtest: next-open fills, fees, no broker orders."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from math import isfinite

@dataclass(frozen=True)
class Bar:
    time: str
    open: float
    close: float

@dataclass(frozen=True)
class Config:
    fast: int = 20
    slow: int = 50
    capital: float = 10000.0
    allocation: float = 0.10
    commission_bps: float = 1.0
    slippage_bps: float = 2.0

def sma(values, n):
    out, rolling = [], 0.0
    for i, val in enumerate(values):
        rolling += val
        if i >= n:
            rolling -= values[i-n]
        out.append(rolling/n if i >= n-1 else None)
    return out

def backtest(bars: list[Bar], config: Config = Config()) -> dict:
    c = config
    if not (isinstance(c.fast, int) and isinstance(c.slow, int) and 2 <= c.fast < c.slow):
        raise ValueError("Require 2 <= fast < slow")
    if not all(isfinite(v) for v in (c.capital, c.allocation, c.commission_bps, c.slippage_bps)):
        raise ValueError("Configuration must be finite")
    if not (c.capital > 0 and 0 < c.allocation <= 1 and 0 <= c.commission_bps < 10000 and 0 <= c.slippage_bps < 10000):
        raise ValueError("Invalid capital/allocation/costs")
    if len(bars) <= c.slow:
        raise ValueError("Insufficient historical bars")
    times = [datetime.fromisoformat(b.time.replace("Z","+00:00")) for b in bars]
    if any(b <= a for a,b in zip(times, times[1:])):
        raise ValueError("Timestamps must strictly increase")
    if any(not (isfinite(b.open) and isfinite(b.close) and b.open > 0 and b.close > 0) for b in bars):
        raise ValueError("Bar prices must be positive and finite")
    closes = [b.close for b in bars]
    fast, slow = sma(closes,c.fast), sma(closes,c.slow)
    cash, units, pending = c.capital, 0, None
    fills, curve = [], []
    peak, worst = c.capital, 0.0
    for i,b in enumerate(bars):
        # Execute only the signal determined using the PREVIOUS close.
        if pending == "BUY" and not units:
            px = b.open * (1 + c.slippage_bps/10000)
            total_unit_cost = px * (1 + c.commission_bps/10000)
            qty = int(min(cash, cash*c.allocation) / total_unit_cost)
            if qty:
                fee = qty * px * c.commission_bps / 10000
                cash -= qty*px + fee
                units += qty
                fills.append(dict(time=b.time, side="BUY", quantity=qty, price=px, fee=fee))
        elif pending == "SELL" and units:
            px = b.open * (1 - c.slippage_bps/10000)
            fee = units*px*c.commission_bps/10000
            fills.append(dict(time=b.time, side="SELL", quantity=units, price=px, fee=fee))
            cash += units*px - fee
            units = 0
        pending = None
        equity = cash + units*b.close
        peak = max(peak, equity)
        worst = max(worst, 1-equity/peak)
        curve.append(dict(time=b.time, equity=round(equity,6)))
        if i >= c.slow and fast[i-1] is not None:
            if fast[i-1] <= slow[i-1] and fast[i] > slow[i] and units == 0:
                pending = "BUY"
            elif fast[i-1] >= slow[i-1] and fast[i] < slow[i] and units:
                pending = "SELL"
    return dict(mode="historical_simulation_only", start_equity=c.capital,
                end_equity=round(cash+units*bars[-1].close,6),
                total_return_pct=round(100*((cash+units*bars[-1].close)/c.capital-1),6),
                max_drawdown_pct=round(worst*100,6), cash=round(cash,6),
                open_shares=units, fills=fills, equity_curve=curve,
                unfilled_final_signal=pending)
