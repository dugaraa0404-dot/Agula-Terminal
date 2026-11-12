"""Research signals and manual local-SQLite paper simulation API.

All trade-mutation endpoints are disabled until an owner sets AGULA_PAPER_TOKEN.
No live brokerage integration, no scheduler, and no real-money capability.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import re
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from trading.paper_bot import PaperAccount, fetch_signal

router = APIRouter(tags=["Experimental paper trading"])
SYMBOL = re.compile(r"^[A-Z0-9.\-]{1,15}$")


class PaperRequest(BaseModel):
    symbol: str = Field(default="SPY", min_length=1, max_length=15)
    fast: int = Field(default=20, ge=2, le=150)
    slow: int = Field(default=50, ge=3, le=250)
    initial_cash: float = Field(default=10000.0, gt=0, le=100000000)
    max_allocation: float = Field(default=0.10, gt=0, le=0.25)
    max_drawdown: float = Field(default=0.05, gt=0, le=0.5)
    fee: float = Field(default=0.0, ge=0, le=100)


def normalize_symbol(raw: str) -> str:
    symbol = raw.strip().upper()
    if not SYMBOL.fullmatch(symbol) or symbol.startswith("-") or symbol.startswith("."):
        raise HTTPException(status_code=422, detail="Unsupported ticker format")
    return symbol


def validate_windows(fast: int, slow: int) -> None:
    if fast >= slow:
        raise HTTPException(status_code=422, detail="Fast MA must be smaller than slow MA")


def database_path(symbol: str) -> str:
    # One symbol per file to avoid incorrectly valuing multi-asset accounts.
    base = Path(os.environ.get("AGULA_PAPER_DIR", "./paper_data")).resolve()
    base.mkdir(parents=True, exist_ok=True)
    return str(base / f"{symbol}.sqlite3")


def authorize(authorization: str | None) -> None:
    secret = os.environ.get("AGULA_PAPER_TOKEN", "")
    if len(secret) < 24:
        raise HTTPException(status_code=503, detail="Paper writes disabled: set a strong AGULA_PAPER_TOKEN")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Bearer token required", headers={"WWW-Authenticate": "Bearer"})
    if not hmac.compare_digest(authorization[len(prefix):], secret):
        raise HTTPException(status_code=403, detail="Unauthorized")


@router.get("/algo", response_class=HTMLResponse)
def algo_dashboard() -> HTMLResponse:
    page = Path(__file__).with_name("algo.html").read_text(encoding="utf-8")
    return HTMLResponse(page, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/api/algo/info")
def info() -> dict:
    return {
        "mode": "LOCAL_SIMULATION_ONLY",
        "broker_connected": False,
        "live_trading_enabled": False,
        "write_enabled": len(os.environ.get("AGULA_PAPER_TOKEN", "")) >= 24,
        "storage": "Local SQLite; ephemeral on hosts without a persistent disk",
        "warning": "Signals use potentially delayed daily data; simulated fills are not executable prices.",
    }


@router.get("/api/algo/signal")
async def get_signal(symbol: str = "SPY", fast: int = 20, slow: int = 50) -> dict:
    ticker = normalize_symbol(symbol)
    if not 2 <= fast <= 150 or not 3 <= slow <= 250:
        raise HTTPException(status_code=422, detail="MA period out of range")
    validate_windows(fast, slow)
    try:
        side, bar, price = await asyncio.wait_for(
            asyncio.to_thread(fetch_signal, ticker, fast, slow), timeout=25
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Market-data request timed out") from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Market data unavailable") from exc
    return {"symbol": ticker, "signal": side, "bar_date": bar,
            "approximate_price": price, "fast": fast, "slow": slow,
            "data_note": "Historical daily bars. Not a live broker execution price."}


@router.post("/api/algo/paper/execute")
async def execute_paper(
    request: PaperRequest, authorization: str | None = Header(default=None)
) -> dict:
    authorize(authorization)
    symbol = normalize_symbol(request.symbol)
    validate_windows(request.fast, request.slow)
    # Fetch the server-side signal: the client cannot forge a BUY/SELL or price.
    result = await get_signal(symbol, request.fast, request.slow)
    def simulate_fill() -> dict:
        # SQLite connections are created, used and closed in the SAME worker thread.
        account = PaperAccount(database_path(symbol), request.initial_cash)
        try:
            return account.execute(
                symbol=symbol, signal=result["signal"],
                signal_id=f"{symbol}:{result['bar_date']}:{request.fast}:{request.slow}",
                price=result["approximate_price"],
                max_allocation=request.max_allocation,
                fee=request.fee, max_drawdown=request.max_drawdown,
            )
        finally:
            account.close()

    fill = await asyncio.to_thread(simulate_fill)
    return {"simulation": True, "symbol": symbol, "bar_date": result["bar_date"],
            "signal": result["signal"], "result": fill,
            "warning": "No broker order has been placed. SQLite storage may be ephemeral."}
