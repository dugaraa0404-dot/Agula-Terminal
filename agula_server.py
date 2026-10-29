"""
Agula Terminal
==============

One Python program that serves the Agula Terminal page and a JSON API built
on real market data:

  * Yahoo Finance (via yfinance): quotes, price history, company profiles,
    annual financial statements, option chains, news, symbol search
  * Cboe delayed quotes: option chains when Yahoo refuses a cloud server
  * US Treasury (official daily par yield curve CSV): the yield curve
  * FRED (St. Louis Fed): macro indicators, policy rates, curve backup;
    official API and release calendar when FRED_API_KEY is set
  * Binance public market data: crypto order books and trades
  * Google News RSS: extra headlines

Run on your computer:   pip install -r requirements.txt
                        python agula.py              -> http://localhost:8000
Render:                 render.yaml (Blueprint) runs  uvicorn agula:app
Cloudflare:             wrangler.jsonc runs this file in a Cloudflare Container
Anywhere with Docker:   docker build -t agula . && docker run -p 8080:8080 agula

Everything is cached in memory (and optionally on disk) so many visitors share
one download, identical concurrent requests are coalesced, and every client is
rate-limited. Market data from Yahoo is delayed and for research only.
"""
from __future__ import annotations

import asyncio
import csv
import html as _html
import io
import json
import logging
import math
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

VERSION = "1.2.0"
HERE = Path(__file__).resolve().parent
PAGE = HERE / "agula_terminal.html"


def _load_dotenv(path: Path) -> None:
    """Read KEY=VALUE lines from a local .env file; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(HERE / ".env")
log = logging.getLogger("agula")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRED_KEY = os.environ.get("FRED_API_KEY", "").strip()
CACHE_DIR = os.environ.get("AGULA_CACHE_DIR", "").strip()
RATE_LIMIT = int(os.environ.get("AGULA_RATE_LIMIT", "240"))        # API requests per minute per client
WARM = os.environ.get("AGULA_WARM", "1") != "0"
UA = {"User-Agent": "Mozilla/5.0 (compatible; AgulaTerminal/1.0)"}
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-=^]{1,20}$")
POOL = ThreadPoolExecutor(max_workers=int(os.environ.get("AGULA_IO_WORKERS", "8")), thread_name_prefix="agula-io")

# The screener / heatmap universe: large US companies across all eleven sectors.
UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "CSCO", "INTC",
    "GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ",
    "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "BKNG",
    "WMT", "PG", "KO", "PEP", "COST", "PM",
    "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "BRK-B", "AXP",
    "LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO",
    "XOM", "CVX", "COP", "SLB",
    "CAT", "GE", "HON", "UPS", "BA", "RTX", "DE",
    "LIN", "FCX", "NEM", "NEE", "DUK", "SO", "PLD", "AMT", "O",
]
SECTOR_ETFS = ["XLK", "XLC", "XLY", "XLP", "XLF", "XLV", "XLE", "XLI", "XLB", "XLU", "XLRE"]
BENCH = "^GSPC"

@asynccontextmanager
async def lifespan(_app):
    if WARM:   # keep caches warm on always-on hosts so first visits are fast
        threading.Thread(target=_warm_loop, daemon=True, name="agula-warm").start()
    yield


app = FastAPI(title="Agula Terminal", version=VERSION, description="Real-data market terminal API", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=800)
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()],
                   allow_methods=["GET", "POST"], allow_headers=["*"])

# =============================================================================
# Cache: TTL + single flight + optional disk persistence for slow datasets
# =============================================================================
_CACHE: dict[str, tuple[float, object]] = {}
_LOCK = threading.Lock()
_INFLIGHT: dict[str, Future] = {}
STATS = defaultdict(int)


def _disk(key: str) -> Path | None:
    if not CACHE_DIR:
        return None
    safe = re.sub(r"[^A-Za-z0-9_.=-]", "_", key)[:150]
    return Path(CACHE_DIR) / f"{safe}.json"


def cached(key: str, ttl: float, fn, persist: bool = False, keep_empty_for: float = 60):
    """Return a cached value; compute it once even when many requests arrive together."""
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < ttl:
        STATS["cache_hit"] += 1
        return hit[1]
    if persist and not hit:
        p = _disk(key)
        if p and p.exists() and now - p.stat().st_mtime < ttl:
            try:
                val = json.loads(p.read_text())
                _CACHE[key] = (p.stat().st_mtime, val)
                return val
            except Exception:
                pass
    with _LOCK:
        fut = _INFLIGHT.get(key)
        owner = fut is None
        if owner:
            fut = Future()
            _INFLIGHT[key] = fut
    if not owner:
        STATS["coalesced"] += 1
        return fut.result(timeout=90)
    try:
        STATS["provider_calls"] += 1
        val = fn()
        empty = val is None or (hasattr(val, "__len__") and len(val) == 0)
        if empty and hit and hit[1]:      # provider returned nothing (often a rate limit): keep the last good data, retry soon
            _CACHE[key] = (time.time() - (ttl - keep_empty_for if ttl > keep_empty_for else 0), hit[1])
            fut.set_result(hit[1])
            return hit[1]
        stamp = time.time() - (ttl - keep_empty_for if empty and ttl > keep_empty_for else 0)
        _CACHE[key] = (stamp, val)
        if persist and not empty:
            p = _disk(key)
            if p:
                try:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(json.dumps(val, default=str))
                except Exception as exc:
                    log.debug("disk cache write failed: %s", exc)
        fut.set_result(val)
        return val
    except BaseException as exc:
        if hit:                       # serve stale data rather than failing
            fut.set_result(hit[1])
            return hit[1]
        fut.set_exception(exc)
        raise
    finally:
        with _LOCK:
            _INFLIGHT.pop(key, None)


def peek(key: str):
    hit = _CACHE.get(key)
    return hit[1] if hit else None


# =============================================================================
# Request guards: symbol validation and per-client rate limiting
# =============================================================================
_HITS: dict[str, deque] = defaultdict(deque)


IP_HEADER = os.environ.get("AGULA_IP_HEADER", "").strip().lower()   # e.g. cf-connecting-ip behind Cloudflare


def client_ip(req: Request) -> str:
    if IP_HEADER and req.headers.get(IP_HEADER):
        return req.headers[IP_HEADER].strip()
    fwd = req.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (req.client.host if req.client else "?")


@app.middleware("http")
async def guards(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/"):
        key, limit, now = client_ip(request), RATE_LIMIT, time.time()
        q = _HITS[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return JSONResponse({"detail": "Too many requests. Please slow down."}, status_code=429, headers={"Retry-After": "20"})
        q.append(now)
    t0 = time.perf_counter()
    resp = await call_next(request)
    resp.headers["Server-Timing"] = f"app;dur={(time.perf_counter() - t0) * 1000:.0f}"
    return resp


def sym_ok(s: str) -> str:
    s = (s or "").strip().upper()
    if not SYMBOL_RE.match(s):
        raise HTTPException(400, f"'{s}' is not a valid symbol.")
    return s


def syms_ok(s: str, cap: int = 80) -> list[str]:
    out = []
    for x in (s or "").split(","):
        x = x.strip().upper()
        if x and SYMBOL_RE.match(x) and x not in out:
            out.append(x)
    return out[:cap]


def fnum(x, nd=6):
    try:
        v = float(x)
    except Exception:
        return None
    return round(v, nd) if math.isfinite(v) else None


# =============================================================================
# Quotes (batched) and history
# =============================================================================
RATE_SYMS = {"^IRX", "^FVX", "^TNX", "^TYX"}
_QUOTES: dict[str, tuple[float, dict]] = {}
_QLOCK = threading.Lock()
QUOTE_TTL = float(os.environ.get("AGULA_QUOTE_TTL", "20"))


def _frame_for(df: pd.DataFrame, sym: str, n_syms: int) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    if isinstance(df.columns, pd.MultiIndex):
        lvl0 = df.columns.get_level_values(0)
        if sym in lvl0:
            return df[sym].dropna(how="all")
        lvl1 = df.columns.get_level_values(1)
        if sym in lvl1:
            return df.xs(sym, axis=1, level=1).dropna(how="all")
        return pd.DataFrame()
    return df.dropna(how="all") if n_syms == 1 else pd.DataFrame()


def _download(syms: list[str], **kw) -> pd.DataFrame:
    return yf.download(syms, group_by="ticker", auto_adjust=False, progress=False, threads=True, **kw)


def _fetch_quotes(syms: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    daily = _download(syms, period="10d", interval="1d")
    try:
        intra = _download(syms, period="1d", interval="1m")
    except Exception:
        intra = pd.DataFrame()
    for s in syms:
        d = _frame_for(daily, s, len(syms))
        i = _frame_for(intra, s, len(syms))
        if d.empty or "Close" not in d:
            continue
        dc = d["Close"].dropna()
        if dc.empty:
            continue
        q = {"sym": s}
        if not i.empty and "Close" in i and i["Close"].dropna().size:
            ic = i["Close"].dropna()
            sess = ic.index[-1].date()
            prev = float(dc.iloc[-2]) if (dc.index[-1].date() == sess and len(dc) > 1) else float(dc.iloc[-1])
            q.update(last=float(ic.iloc[-1]), prev=prev, open=fnum(i["Open"].dropna().iloc[0]), high=fnum(i["High"].max()), low=fnum(i["Low"].min()),
                     vol=fnum(i["Volume"].sum()) if "Volume" in i else None, t=int(ic.index[-1].timestamp() * 1000))
        else:
            q.update(last=float(dc.iloc[-1]), prev=float(dc.iloc[-2]) if len(dc) > 1 else float(dc.iloc[-1]),
                     open=fnum(d["Open"].iloc[-1]), high=fnum(d["High"].iloc[-1]), low=fnum(d["Low"].iloc[-1]),
                     vol=fnum(d["Volume"].iloc[-1]) if "Volume" in d else None, t=int(pd.Timestamp(dc.index[-1]).timestamp() * 1000))
        if s in RATE_SYMS and q["last"] > 20:          # some feeds quote yields x10
            for k in ("last", "prev", "open", "high", "low"):
                if q.get(k) is not None:
                    q[k] = q[k] / 10
        q["chg"] = q["last"] - q["prev"]
        q["chgPct"] = q["last"] / q["prev"] - 1 if q["prev"] else 0.0
        q["src"] = "YAHOO"
        out[s] = q
    return out


def get_quotes(syms: list[str]) -> dict[str, dict]:
    now = time.time()
    with _QLOCK:
        stale = [s for s in syms if s not in _QUOTES or now - _QUOTES[s][0] > QUOTE_TTL]
    if stale:
        for k in range(0, len(stale), 80):
            chunk = stale[k:k + 80]
            try:
                got = cached("quotes:" + ",".join(sorted(chunk)), QUOTE_TTL / 2, lambda c=chunk: _fetch_quotes(c), keep_empty_for=10)
            except Exception as exc:
                log.warning("quote batch failed: %s", exc)
                got = {}
            with _QLOCK:
                for s, q in got.items():
                    _QUOTES[s] = (time.time(), q)
    with _QLOCK:
        return {s: _QUOTES[s][1] for s in syms if s in _QUOTES}


TF = {  # timeframe -> (period, interval, cache seconds)
    "1m": ("5d", "1m", 60), "5m": ("1mo", "5m", 120), "1H": ("6mo", "1h", 600),
    "1D": ("5y", "1d", 900), "1W": ("10y", "1wk", 3600),
}


def _bars(df: pd.DataFrame, rate: bool) -> list[list]:
    out = []
    for ts, r in df.iterrows():
        c = r.get("Close")
        if c is None or not math.isfinite(float(c)):
            continue
        k = 0.1 if (rate and float(c) > 20) else 1.0
        out.append([int(pd.Timestamp(ts).timestamp() * 1000), fnum(r["Open"] * k), fnum(r["High"] * k), fnum(r["Low"] * k), fnum(c * k), fnum(r.get("Volume", 0)) or 0])
    return out


def get_history(sym: str, tf: str) -> list[list]:
    period, interval, ttl = TF[tf]

    def load():
        df = yf.Ticker(sym).history(period=period, interval=interval, auto_adjust=True)
        if df is None or df.empty:
            return []
        return _bars(df, sym in RATE_SYMS)
    return cached(f"hist:{sym}:{tf}", ttl, load)


# =============================================================================
# Company data: info, profile, statements
# =============================================================================
INFO_FIELDS = ["quoteType", "shortName", "longName", "currency", "exchange", "fullExchangeName", "sector", "industry", "longBusinessSummary", "website",
               "country", "fullTimeEmployees", "marketCap", "enterpriseValue", "trailingPE", "forwardPE", "enterpriseToEbitda", "enterpriseToRevenue",
               "priceToSalesTrailing12Months", "priceToBook", "beta", "dividendRate", "trailingAnnualDividendYield", "payoutRatio", "fiftyTwoWeekHigh",
               "fiftyTwoWeekLow", "targetMeanPrice", "targetHighPrice", "targetLowPrice", "numberOfAnalystOpinions", "recommendationKey", "revenueGrowth",
               "earningsGrowth", "operatingMargins", "profitMargins", "grossMargins", "returnOnEquity", "freeCashflow", "operatingCashflow", "totalCash",
               "totalDebt", "sharesOutstanding", "currentPrice", "regularMarketPrice", "bid", "ask", "bidSize", "askSize", "shortRatio", "heldPercentInstitutions",
               "ebitda", "totalRevenue", "trailingEps", "forwardEps", "pegRatio", "debtToEquity", "currentRatio", "quickRatio"]


def get_info(sym: str) -> dict:
    def load():
        raw = yf.Ticker(sym).info or {}
        out = {k: raw.get(k) for k in INFO_FIELDS if raw.get(k) is not None}
        officers = raw.get("companyOfficers") or []
        if officers and isinstance(officers, list):
            out["ceo"] = officers[0].get("name")
        if not out.get("quoteType") and not out.get("shortName"):
            return {}
        return out
    return cached(f"info:{sym}", 12 * 3600, load, persist=True, keep_empty_for=120)


def _row(df: pd.DataFrame, *names) -> pd.Series | None:
    if df is None or df.empty:
        return None
    idx = {str(i).strip().lower(): i for i in df.index}
    for n in names:
        k = idx.get(n.lower())
        if k is not None:
            return df.loc[k]
    return None


def _val(series: pd.Series | None, col):
    if series is None or col not in series.index:
        return None
    return fnum(series[col], 2)


def get_fundamentals(sym: str) -> dict:
    def load():
        t = yf.Ticker(sym)
        inc, bal, cf = t.financials, t.balance_sheet, t.cashflow
        if inc is None or inc.empty:
            return {}
        cols = sorted(inc.columns)
        R = {k: _row(inc, *v) for k, v in {
            "rev": ["Total Revenue", "Operating Revenue"], "gp": ["Gross Profit"], "op": ["Operating Income", "Total Operating Income As Reported"],
            "ebit": ["EBIT"], "int": ["Interest Expense", "Interest Expense Non Operating"], "pre": ["Pretax Income"], "tax": ["Tax Provision"],
            "ni": ["Net Income", "Net Income Common Stockholders"], "dep": ["Reconciled Depreciation", "Depreciation And Amortization In Income Statement"],
            "sh": ["Diluted Average Shares", "Basic Average Shares"]}.items()}
        C = {k: _row(cf, *v) for k, v in {
            "ocf": ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"], "capex": ["Capital Expenditure", "Purchase Of PPE"],
            "fcf": ["Free Cash Flow"], "da": ["Depreciation And Amortization", "Depreciation Amortization Depletion"], "wc": ["Change In Working Capital"]}.items()}
        B = {k: _row(bal, *v) for k, v in {
            "cash": ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"], "debt": ["Total Debt"],
            "mi": ["Minority Interest"], "shares": ["Ordinary Shares Number", "Share Issued"],
            "eq": ["Stockholders Equity", "Common Stock Equity", "Total Equity Gross Minority Interest"]}.items()}
        years = []
        for c in cols:
            rev = _val(R["rev"], c)
            if not rev:
                continue
            op = _val(R["op"], c)
            ebit = op if op is not None else _val(R["ebit"], c)
            pre, tax = _val(R["pre"], c), _val(R["tax"], c)
            da = _val(C["da"], c) if c in (cf.columns if cf is not None else []) else None
            if da is None:
                da = _val(R["dep"], c)
            capex = _val(C["capex"], c) if cf is not None and c in cf.columns else None
            ocf = _val(C["ocf"], c) if cf is not None and c in cf.columns else None
            fcf = _val(C["fcf"], c) if cf is not None and c in cf.columns else None
            years.append({
                "year": int(pd.Timestamp(c).year), "date": str(pd.Timestamp(c).date()), "revenue": rev, "grossProfit": _val(R["gp"], c), "ebit": ebit,
                "da": abs(da) if da is not None else None, "capex": -abs(capex) if capex is not None else None, "interest": abs(_val(R["int"], c) or 0),
                "pretax": pre, "taxRate": (max(0.0, min(0.5, tax / pre)) if (pre and pre > 0 and tax is not None) else None), "netIncome": _val(R["ni"], c),
                "ocf": ocf, "fcf": fcf if fcf is not None else ((ocf + capex) if (ocf is not None and capex is not None) else None),
                "dWC": _val(C["wc"], c) if cf is not None and c in cf.columns else None, "shares": _val(R["sh"], c),
                # balance sheet at fiscal year end (for invested capital, ROIC and sales-to-capital)
                "equityBook": _val(B["eq"], c) if bal is not None and c in bal.columns else None,
                "debtBook": _val(B["debt"], c) if bal is not None and c in bal.columns else None,
                "cashBook": _val(B["cash"], c) if bal is not None and c in bal.columns else None,
            })
        if not years:
            return {}
        info = get_info(sym)
        last_bal = sorted(bal.columns)[-1] if bal is not None and not bal.empty else None
        cash = _val(B["cash"], last_bal) or info.get("totalCash") or 0
        debt = _val(B["debt"], last_bal) or info.get("totalDebt") or 0
        shares = info.get("sharesOutstanding") or _val(B["shares"], last_bal) or years[-1].get("shares")
        drev = [years[i]["revenue"] - years[i - 1]["revenue"] for i in range(1, len(years))]
        dwc = [-(years[i]["dWC"] or 0) for i in range(1, len(years))]
        ratios = [w / d for w, d in zip(dwc, drev) if d > 0]
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        return {
            "name": info.get("longName") or info.get("shortName") or sym, "sector": info.get("sector") or "—", "industry": info.get("industry") or "—",
            "currency": info.get("financialCurrency") or info.get("currency") or "USD", "description": info.get("longBusinessSummary") or "",
            "years": years, "cash": cash, "debt": debt, "shares": shares, "minority": _val(B["mi"], last_bal) or 0,
            "nwcPct": max(0.0, min(0.3, float(np.mean(ratios)))) if ratios else 0.08,
            "costOfDebt": max(0.02, min(0.12, (years[-1]["interest"] or 0) / debt)) if debt else None,
            "divYield": (info.get("dividendRate") or 0) / price if price else (info.get("trailingAnnualDividendYield") or 0),
            "beta": info.get("beta"), "employees": info.get("fullTimeEmployees"), "source": "Yahoo Finance (annual company filings)",
            "country": info.get("country") or "United States", "marketCap": info.get("marketCap"), "quoteType": info.get("quoteType"),
        }
    return cached(f"fund2:{sym}", 24 * 3600, load, persist=True, keep_empty_for=300)


class SourceError(RuntimeError):
    """A data-source failure whose message is safe and useful to show to the visitor."""


def http_get(url: str, params: dict | None = None, timeout: float = 20, tries: int = 3, headers: dict | None = None) -> requests.Response:
    """GET with retries and backoff for timeouts, dropped connections and 429/5xx answers."""
    last: Exception | None = None
    for k in range(tries):
        try:
            r = requests.get(url, params=params, headers=headers or UA, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504) and k < tries - 1:
                last = requests.HTTPError(f"HTTP {r.status_code}")
                time.sleep(1.5 * (k + 1))
                continue
            r.raise_for_status()
            return r
        except (requests.Timeout, requests.ConnectionError) as exc:
            last = exc
            if k < tries - 1:
                time.sleep(1.5 * (k + 1))
    raise last if last else RuntimeError("request failed")


# =============================================================================
# Options: Yahoo Finance first; Cboe's free delayed chains when Yahoo refuses
# =============================================================================
# Yahoo's options endpoint needs a session "crumb", which Yahoo often refuses to cloud
# servers (Render, Cloudflare...). yfinance then silently returns an empty list, which looks
# exactly like "this symbol has no options". So Agula asks Yahoo directly, tells a refusal
# apart from a genuine "none", and falls back to Cboe's public delayed quotes.
NO_LISTED_OPTIONS = re.compile(r"(=X|=F|-USD)$")          # FX pairs, futures, crypto
CBOE_INDEX = {"^SPX": "_SPX", "^GSPC": "_SPX", "^NDX": "_NDX", "^RUT": "_RUT", "^VIX": "_VIX", "^XSP": "_XSP", "^DJX": "_DJX", "^XND": "_XND"}
OCC_RE = re.compile(r"^(.+?)(\d{6})([CP])(\d{8})$")      # root + YYMMDD + C/P + strike x 1000
_OPT_SRC: dict[str, tuple[float, dict]] = {}


def _yahoo_options_raw(sym: str, epoch: int | None = None) -> dict | None:
    """Yahoo's option chain JSON for sym. {} = Yahoo says there are no options; None = Yahoo refused or failed."""
    client = getattr(yf.Ticker(sym), "_data", None)       # yfinance's session (handles cookies and crumb)
    if client is None or not hasattr(client, "get"):
        return None
    params = {"date": epoch} if epoch else None
    for host in ("query2", "query1"):
        try:
            r = client.get(url=f"https://{host}.finance.yahoo.com/v7/finance/options/{sym}", params=params, timeout=15)
            if r.status_code >= 400:
                log.info("yahoo options %s: HTTP %s", sym, r.status_code)
                continue
            j = r.json()
        except Exception as exc:
            log.info("yahoo options %s failed: %s", sym, exc)
            continue
        oc = j.get("optionChain") or {}
        if oc.get("error") or j.get("finance", {}).get("error"):
            continue
        res = oc.get("result") or []
        return res[0] if res else {}
    return None


def _cboe_candidates(sym: str) -> list[str]:
    if sym in CBOE_INDEX:
        return [CBOE_INDEX[sym]]
    if sym.startswith("^"):
        return ["_" + sym[1:]]
    if "-" in sym:                                        # BRK-B -> BRK.B / BRKB
        return [sym.replace("-", "."), sym.replace("-", "")]
    return [sym]


def get_cboe_chain(sym: str) -> dict:
    """All expiries from Cboe's public delayed (15 min) quotes: {'spot', 'expiries': {date: {'calls', 'puts'}}}."""
    def load():
        for c in _cboe_candidates(sym):
            r = requests.get(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{c}.json", headers=UA, timeout=25)
            if r.status_code in (403, 404):                # symbol not on Cboe's list
                continue
            r.raise_for_status()
            d = (r.json() or {}).get("data") or {}
            spot = fnum(d.get("current_price") or d.get("close"), 4)
            raw = d.get("options") or []
            if not raw:
                continue
            ivs = [float(o["iv"]) for o in raw if isinstance(o.get("iv"), (int, float)) and o["iv"] > 0]
            iv_scale = 0.01 if ivs and float(np.median(ivs)) > 3 else 1.0     # guard against percent units
            today = date.today().isoformat()
            best: dict[tuple, dict] = {}
            for o in raw:
                m = OCC_RE.match(str(o.get("option", "")))
                if not m:
                    continue
                y = m.group(2)
                exp = f"20{y[:2]}-{y[2:4]}-{y[4:]}"
                if exp < today:
                    continue
                side, K = m.group(3), int(m.group(4)) / 1000
                iv = o.get("iv")
                row = {"K": K, "bid": fnum(o.get("bid"), 4), "ask": fnum(o.get("ask"), 4), "last": fnum(o.get("last_trade_price"), 4),
                       "iv": fnum(iv * iv_scale, 5) if isinstance(iv, (int, float)) and iv > 0 else None,
                       "oi": int(o.get("open_interest") or 0), "vol": int(o.get("volume") or 0),
                       "itm": bool(spot and ((K < spot) if side == "C" else (K > spot)))}
                key = (exp, side, K)                       # weekly + monthly roots can share a strike: keep the busier one
                if key not in best or row["oi"] + row["vol"] > best[key]["oi"] + best[key]["vol"]:
                    best[key] = row
            exps: dict[str, dict] = {}
            for (exp, side, _), row in best.items():
                e = exps.setdefault(exp, {"calls": [], "puts": []})
                e["calls" if side == "C" else "puts"].append(row)
            for e in exps.values():
                e["calls"].sort(key=lambda x: x["K"])
                e["puts"].sort(key=lambda x: x["K"])
            return {"symbol": c, "spot": spot, "expiries": dict(sorted(exps.items()))}
        return {}
    return cached(f"cboe:{sym}", 300, load, keep_empty_for=900)


def _probe_options(sym: str) -> dict:
    if NO_LISTED_OPTIONS.search(sym):
        return {"status": "none", "source": None, "expirations": [], "epochs": {}}
    y = _yahoo_options_raw(sym)
    if y and y.get("expirationDates"):
        epochs = {datetime.fromtimestamp(e, tz=timezone.utc).strftime("%Y-%m-%d"): int(e) for e in y["expirationDates"]}
        return {"status": "ok", "source": "Yahoo Finance", "expirations": sorted(epochs), "epochs": epochs}
    cboe_failed = False
    try:
        cb = get_cboe_chain(sym)
    except Exception as exc:
        log.info("cboe options %s failed: %s", sym, exc)
        cb, cboe_failed = {}, True
    if cb.get("expiries"):
        return {"status": "ok", "source": "Cboe (delayed 15 min)", "expirations": list(cb["expiries"]), "epochs": {}}
    # Yahoo answered "none" (y == {} or no dates) and Cboe has nothing: genuinely no listed options.
    if y is not None and not cboe_failed:
        return {"status": "none", "source": None, "expirations": [], "epochs": {}}
    return {"status": "unavailable", "source": None, "expirations": [], "epochs": {}}


def option_source(sym: str) -> dict:
    """Where sym's options come from; good answers are kept 30 min, failures retried after 1 min."""
    now, hit = time.time(), _OPT_SRC.get(sym)
    if hit and now - hit[0] < (60 if hit[1]["status"] == "unavailable" else 1800):
        return hit[1]
    res = cached(f"optprobe:{sym}", 5, lambda: _probe_options(sym))   # coalesce simultaneous probes
    if res["status"] == "unavailable" and hit and hit[1]["status"] == "ok":
        res = hit[1]                                       # keep the last good answer through a blip
    _OPT_SRC[sym] = (now, res)
    return res


def get_expirations(sym: str) -> list[str]:
    return option_source(sym)["expirations"]


def _yahoo_rows(lst: list[dict]) -> list[dict]:
    out = []
    for r in lst or []:
        out.append({"K": fnum(r.get("strike"), 4), "bid": fnum(r.get("bid"), 4), "ask": fnum(r.get("ask"), 4), "last": fnum(r.get("lastPrice"), 4),
                    "iv": fnum(r.get("impliedVolatility"), 5), "oi": int(r.get("openInterest") or 0), "vol": int(r.get("volume") or 0),
                    "itm": bool(r.get("inTheMoney"))})
    return sorted(out, key=lambda x: x["K"] or 0)


def get_chain(sym: str, expiry: str) -> dict:
    src = option_source(sym)
    if src["source"] == "Yahoo Finance" and expiry in src["epochs"]:
        def load():
            res = _yahoo_options_raw(sym, src["epochs"][expiry])
            opt = (res or {}).get("options") or []
            if not opt:
                return {}
            return {"expiry": expiry, "calls": _yahoo_rows(opt[0].get("calls")), "puts": _yahoo_rows(opt[0].get("puts")), "source": "Yahoo Finance"}
        ch = cached(f"chain:{sym}:{expiry}", 300, load)
        if ch and (ch["calls"] or ch["puts"]):
            return ch
    try:
        cb = get_cboe_chain(sym)
    except Exception as exc:
        log.info("cboe chain %s failed: %s", sym, exc)
        cb = {}
    e = (cb.get("expiries") or {}).get(expiry)
    if e:
        return {"expiry": expiry, "calls": e["calls"], "puts": e["puts"], "source": "Cboe (delayed 15 min)"}
    raise SourceError(f"Option prices for {sym} expiring {expiry} aren't available right now (Yahoo refused the request and Cboe has no data). Try again in a few minutes.")


def get_surface(sym: str, spot: float) -> list[dict]:
    exps = get_expirations(sym)[:10]
    futs = {e: POOL.submit(get_chain, sym, e) for e in exps}
    out = []
    for e, f in futs.items():
        try:
            ch = f.result(timeout=40)
        except Exception:
            continue
        pts = []
        for side, rows in (("P", ch["puts"]), ("C", ch["calls"])):
            for r in rows:
                K, iv = r["K"], r["iv"]
                if not K or not iv or iv < 0.01 or iv > 4:
                    continue
                if (side == "P" and K > spot) or (side == "C" and K < spot):   # out-of-the-money side only
                    continue
                if (r["bid"] or 0) <= 0 and (r["oi"] or 0) == 0:
                    continue
                pts.append([K / spot, iv])
        pts.sort()
        if len(pts) >= 3:
            out.append({"expiry": e, "points": pts})
    return out


# =============================================================================
# FRED: curve, macro dashboard, rates
# =============================================================================
_FRED_SLOTS = threading.Semaphore(4)       # FRED times out when hit with many parallel requests


def fred_series(sid: str, start: str | None = None) -> list[list]:
    """One FRED series as [[date, value]]. Uses the official API when FRED_API_KEY is set (more reliable)."""
    def load():
        with _FRED_SLOTS:
            if FRED_KEY:
                params = {"series_id": sid, "api_key": FRED_KEY, "file_type": "json"}
                if start:
                    params["observation_start"] = start
                r = http_get("https://api.stlouisfed.org/fred/series/observations", params=params, timeout=20, tries=3)
                out = []
                for o in r.json().get("observations", []):
                    try:
                        out.append([o["date"], float(o["value"])])
                    except (KeyError, ValueError):
                        continue                         # "." marks a missing value
                return out
            params = {"id": sid}
            if start:
                params["cosd"] = start
            r = http_get("https://fred.stlouisfed.org/graph/fredgraph.csv", params=params, timeout=20, tries=2)
        out = []
        for line in r.text.strip().splitlines()[1:]:
            parts = line.split(",")
            if len(parts) < 2:
                continue
            try:
                out.append([parts[0], float(parts[1])])
            except ValueError:
                continue
        return out
    return cached(f"fred:{sid}:{start}", 6 * 3600, load, persist=True)


CURVE_IDS = [("DGS1MO", 1 / 12), ("DGS3MO", 0.25), ("DGS6MO", 0.5), ("DGS1", 1), ("DGS2", 2), ("DGS3", 3), ("DGS5", 5), ("DGS7", 7), ("DGS10", 10), ("DGS20", 20), ("DGS30", 30)]
TENORS = [t for _, t in CURVE_IDS]
TREASURY_COLS = {"1 Mo": 1 / 12, "3 Mo": 0.25, "6 Mo": 0.5, "1 Yr": 1, "2 Yr": 2, "3 Yr": 3, "5 Yr": 5, "7 Yr": 7, "10 Yr": 10, "20 Yr": 20, "30 Yr": 30}


def _curve_payload(rows: dict[str, dict[float, float]], source: str) -> dict:
    """rows: ISO date -> {tenor in years: par yield in %}. Builds what the CURVE screen expects."""
    dates = sorted(d for d, v in rows.items() if 10 in v)
    if not dates:
        raise SourceError(f"{source} returned no 10-year yield")

    def at(days_ago):
        target = (datetime.fromisoformat(dates[-1]) - timedelta(days=days_ago)).date().isoformat()
        d = max([x for x in dates if x <= target] or [dates[0]])
        return d, [[t, rows[d][t] / 100] for t in TENORS if t in rows[d]]

    def spread(a, b):
        return [[d, round(rows[d][a] - rows[d][b], 4)] for d in dates if a in rows[d] and b in rows[d]]
    d0, now = at(0)
    return {"date": d0, "now": now, "w1": at(7)[1], "m1": at(30)[1], "y1": at(365)[1],
            "spreads": {"T10Y2Y": spread(10, 2), "T10Y3M": spread(10, 0.25)},
            "hist10": [[d, rows[d][10]] for d in dates[-756:]], "source": source}


def treasury_year(year: int) -> dict[str, dict[str, float]]:
    """US Treasury's official daily par yield curve for one year: ISO date -> {column: %}."""
    def load():
        r = http_get(f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all",
                     params={"type": "daily_treasury_yield_curve", "field_tdr_date_value": year, "page": "", "_format": "csv"}, timeout=20, tries=2)
        out: dict[str, dict[str, float]] = {}
        for row in csv.DictReader(io.StringIO(r.text.lstrip("﻿"))):
            try:
                d = datetime.strptime((row.get("Date") or "").strip(), "%m/%d/%Y").date().isoformat()
            except ValueError:
                continue
            vals = {}
            for col in TREASURY_COLS:
                try:
                    vals[col] = float(row.get(col) or "")
                except ValueError:
                    pass
            if vals:
                out[d] = vals
        return out
    current = year == date.today().year
    return cached(f"ust:{year}", 3 * 3600 if current else 7 * 86400, load, persist=True)


def _curve_treasury(deadline: float = 35) -> dict:
    y, t0 = date.today().year, time.time()
    futs = {yr: POOL.submit(treasury_year, yr) for yr in (y, y - 1, y - 2, y - 3)}   # one request per year, in parallel
    rows: dict[str, dict[float, float]] = {}
    for yr, f in futs.items():
        try:
            data = f.result(timeout=max(1.0, deadline - (time.time() - t0)))
        except Exception as exc:
            if yr >= y - 1:                               # the two most recent years are required
                raise
            log.info("treasury %s skipped: %s", yr, exc)   # older years only feed the spread history
            continue
        for d, vals in data.items():
            rows[d] = {TREASURY_COLS[c]: v for c, v in vals.items()}
    return _curve_payload(rows, "US Treasury, daily par yield curve (official)")


def _curve_fred(deadline: float = 40) -> dict:
    start, t0 = (date.today() - timedelta(days=3 * 365 + 30)).isoformat(), time.time()
    futs = {t: POOL.submit(fred_series, sid, start) for sid, t in CURVE_IDS}
    rows: dict[str, dict[float, float]] = defaultdict(dict)
    for t, f in futs.items():                             # tenors still loading at the deadline are skipped (they finish into the cache)
        try:
            for d, v in f.result(timeout=max(0.5, deadline - (time.time() - t0))):
                rows[d][t] = v
        except Exception as exc:
            log.info("fred tenor %s failed: %s", t, exc)
    return _curve_payload(rows, "FRED, US Treasury par yields (daily)")


def _curve_yahoo() -> dict:
    rows: dict[str, dict[float, float]] = defaultdict(dict)
    for sym, t in (("^IRX", 0.25), ("^FVX", 5), ("^TNX", 10), ("^TYX", 30)):
        for b in get_history(sym, "1D"):
            rows[datetime.fromtimestamp(b[0] / 1000, tz=timezone.utc).date().isoformat()][t] = b[4]
    return _curve_payload(rows, "Yahoo Finance Treasury yield indices (4 tenors only: Treasury and FRED unavailable)")


def get_curve() -> dict:
    def load():
        errors = []
        for name, fn in (("US Treasury", _curve_treasury), ("FRED", _curve_fred), ("Yahoo", _curve_yahoo)):
            try:
                return fn()
            except Exception as exc:
                errors.append(f"{name}: {type(exc).__name__}")
                log.warning("curve source %s failed: %s", name, exc)
        raise SourceError("No Treasury yield source answered (" + "; ".join(errors) + "). Try again in a minute.")
    return cached("curve", 3 * 3600, load)


MACRO = [
    ("CPIAUCSL", "CPI inflation", "yoy", "%", "https://fred.stlouisfed.org/series/CPIAUCSL"),
    ("CPILFESL", "Core CPI inflation", "yoy", "%", "https://fred.stlouisfed.org/series/CPILFESL"),
    ("PCEPILFE", "Core PCE inflation", "yoy", "%", "https://fred.stlouisfed.org/series/PCEPILFE"),
    ("UNRATE", "Unemployment rate", "level", "%", "https://fred.stlouisfed.org/series/UNRATE"),
    ("PAYEMS", "Payroll change (thousands)", "diff", "k", "https://fred.stlouisfed.org/series/PAYEMS"),
    ("A191RL1Q225SBEA", "Real GDP growth (annualised)", "level", "%", "https://fred.stlouisfed.org/series/A191RL1Q225SBEA"),
    ("DFEDTARU", "Fed funds target (upper)", "level", "%", "https://fred.stlouisfed.org/series/DFEDTARU"),
    ("ICSA", "Initial jobless claims", "level_k", "k", "https://fred.stlouisfed.org/series/ICSA"),
    ("UMCSENT", "Consumer sentiment (UMich)", "level", "", "https://fred.stlouisfed.org/series/UMCSENT"),
    ("BAMLH0A0HYM2", "High-yield credit spread", "level", "%", "https://fred.stlouisfed.org/series/BAMLH0A0HYM2"),
    ("T10Y2Y", "10y minus 2y Treasury", "level", "%", "https://fred.stlouisfed.org/series/T10Y2Y"),
    ("DCOILWTICO", "WTI crude oil", "level", "$", "https://fred.stlouisfed.org/series/DCOILWTICO"),
]


def get_macro() -> list[dict]:
    def load():
        start = (date.today() - timedelta(days=6 * 365)).isoformat()
        futs = {m[0]: POOL.submit(fred_series, m[0], start) for m in MACRO}
        out = []
        for sid, label, kind, unit, url in MACRO:
            try:
                s = futs[sid].result(timeout=40)
            except Exception:
                s = []
            if len(s) < 3:
                continue
            vals = [v for _, v in s]
            dates = [d for d, _ in s]
            if kind == "yoy":
                lag = 12
                ser = [[dates[i], (vals[i] / vals[i - lag] - 1) * 100] for i in range(lag, len(vals))]
            elif kind == "diff":
                ser = [[dates[i], vals[i] - vals[i - 1]] for i in range(1, len(vals))]
            elif kind == "level_k":
                ser = [[d, v / 1000] for d, v in s]
            else:
                ser = s
            if len(ser) < 2:
                continue
            out.append({"id": sid, "label": label, "unit": unit, "date": ser[-1][0], "value": round(ser[-1][1], 3), "prior": round(ser[-2][1], 3),
                        "history": [[d, round(v, 3)] for d, v in ser[-60:]] if len(ser) > 60 else [[d, round(v, 3)] for d, v in ser], "url": url})
        return out
    return cached("macro", 6 * 3600, load)


# Short-term rates for FX carry: Fed and ECB from FRED; others OECD 3-month interbank rates (monthly).
RATE_SOURCES = {"USD": "DFEDTARU", "EUR": "ECBDFR", "GBP": "IR3TIB01GBM156N", "JPY": "IR3TIB01JPM156N", "CHF": "IR3TIB01CHM156N",
                "CAD": "IR3TIB01CAM156N", "AUD": "IR3TIB01AUM156N", "CNY": "IR3TIB01CNM156N"}
RATE_FALLBACK = {"USD": 4.0, "EUR": 2.0, "GBP": 3.75, "JPY": 0.75, "CHF": 0.0, "CAD": 2.5, "AUD": 3.6, "CNY": 1.4, "MNT": 12.5}


def get_fx_rates() -> dict:
    def load():
        start = (date.today() - timedelta(days=400)).isoformat()
        futs = {c: POOL.submit(fred_series, sid, start) for c, sid in RATE_SOURCES.items()}
        out = {}
        for c, sid in RATE_SOURCES.items():
            try:
                s = futs[c].result(timeout=30)
            except Exception:
                s = []
            if s:
                out[c] = {"rate": s[-1][1] / 100, "date": s[-1][0], "source": f"FRED {sid}"}
            else:
                out[c] = {"rate": RATE_FALLBACK[c] / 100, "date": None, "source": "fallback (edit if out of date)"}
        out["MNT"] = {"rate": RATE_FALLBACK["MNT"] / 100, "date": None, "source": "Bank of Mongolia policy rate (set in server; edit if changed)"}
        return out
    return cached("fxrates", 12 * 3600, load)


# =============================================================================
# Damodaran (NYU Stern) data: cost of capital and industry benchmarks for the DCF
# =============================================================================
# Aswath Damodaran publishes, every January, industry averages for US companies
# (betas, cost of capital, margins, reinvestment, working capital, tax rates,
# returns on capital), a table of country risk premiums, and the interest-coverage
# table behind synthetic credit ratings. He also updates the implied equity risk
# premium of the S&P 500 every month. Agula downloads those files, keeps them for
# a day (on disk too, if AGULA_CACHE_DIR is set) and uses them as the defaults of
# the DCF's cost of capital and industry comparisons.
DAMO_ROOT = os.environ.get("AGULA_DAMODARAN_URL", "https://pages.stern.nyu.edu/~adamodar").rstrip("/")
DAMO_FILES = {   # key -> (path under DAMO_ROOT, first header cell, page with the same data as HTML)
    "betas": ("pc/datasets/betas.xls", "industry name", "New_Home_Page/datafile/Betas.html"),
    "wacc": ("pc/datasets/wacc.xls", "industry name", "New_Home_Page/datafile/wacc.html"),
    "margin": ("pc/datasets/margin.xls", "industry name", "New_Home_Page/datafile/margin.html"),
    "capex": ("pc/datasets/capex.xls", "industry name", "New_Home_Page/datafile/capex.html"),
    "wc": ("pc/datasets/wcdata.xls", "industry name", "New_Home_Page/datafile/wcdata.html"),
    "tax": ("pc/datasets/taxrate.xls", "industry name", "New_Home_Page/datafile/taxrate.html"),
    "eva": ("pc/datasets/EVA.xls", "industry name", "New_Home_Page/datafile/EVA.html"),
    "histgr": ("pc/datasets/histgr.xls", "industry name", "New_Home_Page/datafile/histgr.html"),
    "country": ("pc/datasets/ctryprem.xlsx", "country", "New_Home_Page/datafile/ctryprem.html"),
    "ratings": ("pc/ratings.xls", None, "New_Home_Page/datafile/ratings.html"),
    "erp": ("pc/implprem/ERPbymonth.xlsx", None, "New_Home_Page/home.htm"),
}
DAMO_LARGE_FIRM = 5e9          # Damodaran's cut-off between the large-firm and small-firm coverage tables
# January 2026 interest-coverage tables (ratings.html), used only if ratings.xls can't be read.
DAMO_RATINGS_2026 = {
    "large": [[-1e5, 0.2, "D2/D", 0.19], [0.2, 0.65, "C2/C", 0.16], [0.65, 0.8, "Ca2/CC", 0.1261], [0.8, 1.25, "Caa/CCC", 0.0885], [1.25, 1.5, "B3/B-", 0.0509],
              [1.5, 1.75, "B2/B", 0.0321], [1.75, 2.0, "B1/B+", 0.0275], [2.0, 2.25, "Ba2/BB", 0.0184], [2.25, 2.5, "Ba1/BB+", 0.0138], [2.5, 3.0, "Baa2/BBB", 0.0111],
              [3.0, 4.25, "A3/A-", 0.0089], [4.25, 5.5, "A2/A", 0.0078], [5.5, 6.5, "A1/A+", 0.007], [6.5, 8.5, "Aa2/AA", 0.0055], [8.5, 1e5, "Aaa/AAA", 0.004]],
    "financial": [[-1e5, 0.05, "D2/D", 0.19], [0.05, 0.1, "C2/C", 0.16], [0.1, 0.2, "Ca2/CC", 0.1261], [0.2, 0.3, "Caa/CCC", 0.0885], [0.3, 0.4, "B3/B-", 0.0509],
                  [0.4, 0.5, "B2/B", 0.0321], [0.5, 0.6, "B1/B+", 0.0275], [0.6, 0.75, "Ba2/BB", 0.0184], [0.75, 0.9, "Ba1/BB+", 0.0138], [0.9, 1.2, "Baa2/BBB", 0.0111],
                  [1.2, 1.5, "A3/A-", 0.0089], [1.5, 2.0, "A2/A", 0.0078], [2.0, 2.5, "A1/A+", 0.007], [2.5, 3.0, "Aa2/AA", 0.0055], [3.0, 1e5, "Aaa/AAA", 0.004]],
}
RATING_RE = re.compile(r"^(Aaa|Aa\d|A\d|Baa\d|Ba\d|B\d|Caa\d?|Ca\d?|C\d?|D\d?)\s*/\s*[A-D][A-D+\-]*$")
_DAMO_SLOTS = threading.Semaphore(3)


def _norm(t) -> str:
    """Header text -> lowercase, single spaces, no spaces around / and parentheses."""
    t = re.sub(r"\s+", " ", str(t or "")).strip().lower()
    return re.sub(r"\s*([/()])\s*", r"\1", t)


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float, np.integer, np.floating)):
        f = float(v)
        return f if math.isfinite(f) else None
    s = str(v).strip().replace(",", "").replace("$", "")
    pct = s.endswith("%")
    try:
        f = float(s.rstrip("%"))
    except ValueError:
        return None
    return f / 100 if pct else f


def _damo_download(key: str) -> bytes:
    path = DAMO_FILES[key][0]
    with _DAMO_SLOTS:
        r = http_get(f"{DAMO_ROOT}/{path}", timeout=40, tries=2)
    if len(r.content) < 500:
        raise SourceError(f"Damodaran {path} looked empty")
    return r.content


def _excel_sheets(content: bytes, path: str) -> dict:
    engine = "xlrd" if path.endswith(".xls") else "openpyxl"
    return pd.read_excel(io.BytesIO(content), sheet_name=None, header=None, engine=engine)


class _TableHTML(HTMLParser):
    """Collects every <table> on a page as rows of cell text (colspans repeated), stdlib only."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self._row, self._cell, self._span = [], None, None, 1

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell, self._span = [], int(dict(attrs).get("colspan") or 1) if str(dict(attrs).get("colspan") or "1").isdigit() else 1

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            text = re.sub(r"\s+", " ", "".join(self._cell).replace("\xa0", " ")).strip()
            self._row.extend([text or None] + [None] * (self._span - 1))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self.tables and any(c for c in self._row):
                self.tables[-1].append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _html_sheets(text: str) -> dict:
    p = _TableHTML()
    p.feed(text)
    return {f"table{i}": pd.DataFrame(t) for i, t in enumerate(p.tables) if len(t) > 3}


def _damo_sheets(key: str) -> dict:
    """Damodaran's Excel file for `key` as {sheet: DataFrame}; his HTML page of the same data if the file can't be read."""
    path, _, page = DAMO_FILES[key]
    try:
        return _excel_sheets(_damo_download(key), path)
    except (requests.Timeout, requests.ConnectionError):
        raise                                    # the site is unreachable: the HTML page won't load either
    except Exception as exc:
        log.info("damodaran %s: Excel unavailable (%s); trying the HTML page", key, exc)
        with _DAMO_SLOTS:
            r = http_get(f"{DAMO_ROOT}/{page}", timeout=40, tries=2)
        sheets = _html_sheets(r.text)
        if not sheets:
            raise SourceError(f"Damodaran {path} and {page} were both unreadable")
        return sheets


def _parse_table(sheets: dict, path: str, first: str, want: tuple = ()) -> tuple[list[str], dict]:
    """Find the sheet whose header row starts with `first` (e.g. "Industry Name") and return
    (column names, {row name: {column: value}}). Duplicate column names get a ".1" suffix."""
    best = None
    for name, df in sheets.items():
        vals = df.values.tolist()
        for i, row in enumerate(vals[:60]):
            cells = [_norm(c) if isinstance(c, str) else "" for c in row]
            if first not in cells:
                continue
            j0 = cells.index(first)
            heads = cells[j0:]
            if want and not all(any(w in h for h in heads) for w in want):
                continue
            cols, seen = [], {}
            for h in heads:
                k = h or f"col{len(cols)}"
                n = seen.get(k, 0)
                seen[k] = n + 1
                cols.append(k if n == 0 else f"{k}.{n}")
            data = {}
            for r in vals[i + 1:]:
                label = r[j0] if j0 < len(r) else None
                if not isinstance(label, str) or not label.strip():
                    if data:
                        break
                    continue
                data[label.strip()] = {c: r[j0 + k] if j0 + k < len(r) else None for k, c in enumerate(cols)}
            if data and (best is None or len(data) > len(best[1])):
                best = (cols, data, name)
            break
    if not best:
        raise SourceError(f"Couldn't find the '{first}' table in Damodaran's {path}")
    return best[0], best[1]


def _pick(cols: list[str], *needles: str, exclude: tuple = ()) -> str | None:
    """First column whose normalized name contains every needle and none of `exclude`."""
    nd = [_norm(n) for n in needles]
    for c in cols:
        if all(n in c for n in nd) and not any(_norm(x) in c for x in exclude):
            return c
    return None


DAMO_FIELDS = {   # dataset -> output field -> (needles, excluded words); first match wins
    "betas": {"firms": (("number of firms",), ()), "beta": (("beta",), ("unlevered", "hilo", "corrected")), "de": (("d/e",), ()),
              "taxEffective": (("effective tax",), ()), "betaU": (("unlevered beta",), ("corrected",)), "cashFirmValue": (("cash/firm",), ()),
              "betaUCash": (("unlevered beta corrected for cash",), ()), "sdEquity": (("standard deviation of equity",), ())},
    "wacc": {"ke": (("cost of equity",), ()), "kdPre": (("cost of debt",), ("after",)), "kdAfter": (("after-tax cost of debt",), ()),
             "debtRatio": (("d/(d+e)",), ()), "wacc": (("cost of capital",), ())},
    "margin": {"grossMargin": (("gross margin",), ()), "netMargin": (("net margin",), ()), "opMargin": (("pre-tax unadjusted operating margin",), ()),
               "opMarginAfterTax": (("after-tax unadjusted operating margin",), ()), "ebitdaMargin": (("ebitda/sales",), ("sg&a", "r&d"))},
    "capex": {"netCapexSales": (("net cap ex/sales",), ()), "salesToCapital": (("sales/invested capital",), ()), "capexDep": (("cap ex/deprecn",), ())},
    "wc": {"nwcSales": (("non-cash wc/sales",), ())},
    "tax": {"taxAvg": (("average across all companies",), ()), "taxAggregate": (("aggregate tax rate",), ())},
    "eva": {"roc": (("roc",), ("wacc",)), "roe": (("roe",), ("coe",))},
    "histgr": {"revGrowthHist": (("revenue",), ("next", "expected")), "revGrowthExp": (("revenue", "next"), ())},
}


def _industry_dataset(key: str) -> dict:
    path, first, _ = DAMO_FILES[key]
    cols, rows = _parse_table(_damo_sheets(key), path, first)
    picks = {f: _pick(cols, *nd, exclude=ex) for f, (nd, ex) in DAMO_FIELDS[key].items()}
    out = {}
    for name, r in rows.items():
        out[name] = {f: _num(r.get(c)) for f, c in picks.items() if c}
    return out


def _country_dataset() -> dict:
    path, first, _ = DAMO_FILES["country"]
    cols, rows = _parse_table(_damo_sheets("country"), path, first, want=("country risk premium",))
    c_rating = _pick(cols, "rating")
    c_spread = _pick(cols, "default spread")
    c_crp = _pick(cols, "country risk premium")
    c_erp = _pick(cols, "equity risk premium", exclude=("cds",))
    c_tax = _pick(cols, "tax")
    out = {}
    for name, r in rows.items():
        n = re.sub(r"[*†]+$", "", name).strip()
        out[n] = {"rating": str(r.get(c_rating) or "").strip() or None, "defaultSpread": _num(r.get(c_spread)), "crp": _num(r.get(c_crp)),
                  "erp": _num(r.get(c_erp)), "tax": _num(r.get(c_tax))}
    if not out:
        raise SourceError("Damodaran's country table was empty")
    return out


def _ratings_dataset() -> dict:
    """Interest coverage -> rating -> default spread tables (large firms, small firms, financial firms)."""
    path = DAMO_FILES["ratings"][0]
    tables = []
    for _, df in _damo_sheets("ratings").items():
        vals = df.values.tolist()
        found: dict[int, list] = defaultdict(list)          # column offset -> rows
        for row in vals:
            for j in range(len(row) - 3):
                lo, hi, rt, sp = row[j:j + 4]
                if isinstance(rt, str) and RATING_RE.match(rt.strip()) and _num(lo) is not None and _num(hi) is not None and _num(sp) is not None:
                    found[j].append([_num(lo), _num(hi), rt.strip(), _num(sp) if _num(sp) < 1 else _num(sp) / 100])
        tables += [t for t in found.values() if len(t) >= 10]
    out = {}
    for t in tables:
        t.sort(key=lambda x: x[0])
        top = t[-1][0]                                        # lower bound of the AAA bucket
        kind = "financial" if top < 5 else "small" if top > 10 else "large"
        out.setdefault(kind, t)
    if "large" not in out:
        raise SourceError("Couldn't find the interest-coverage table in Damodaran's ratings.xls")
    return out


MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"


def _erp_dataset() -> dict:
    """Latest monthly implied ERP of the S&P 500 (ERPbymonth.xlsx; the home page as a fallback)."""
    path = DAMO_FILES["erp"][0]
    try:
        for _, df in _excel_sheets(_damo_download("erp"), path).items():
            vals = df.values.tolist()
            for i, row in enumerate(vals[:30]):
                heads = [_norm(c) if isinstance(c, str) else "" for c in row]
                cand = [j for j, h in enumerate(heads) if "erp" in h or "premium" in h]
                if not cand:
                    continue
                hz = {j: heads[j].replace(" ", "") for j in cand}       # "T12 m" and "T12m" both occur
                pref = [j for j in cand if "t12m" in hz[j] and ("adjust" in hz[j] or "sustainable" in hz[j])] or \
                       [j for j in cand if "adjust" in hz[j] or "sustainable" in hz[j]] or [j for j in cand if "t12m" in hz[j]] or cand
                j = pref[0]
                last = None
                for r in vals[i + 1:]:
                    d = next((x for x in r if isinstance(x, (datetime, pd.Timestamp))), None)
                    v = _num(r[j]) if j < len(r) else None
                    if d is not None and v is not None:
                        last = (pd.Timestamp(d).date().isoformat(), v if v < 1 else v / 100)
                if last:
                    return {"value": last[1], "date": last[0], "source": f"Damodaran implied ERP by month ({heads[j]})", "url": f"{DAMO_ROOT}/{path}"}
    except Exception as exc:
        log.info("ERPbymonth unreadable: %s", exc)
    r = http_get(f"{DAMO_ROOT}/{DAMO_FILES['erp'][2]}", timeout=25, tries=2)
    text = re.sub(r"<[^>]+>", " ", r.text)
    text = re.sub(r"\s+", " ", _html.unescape(text))
    m = re.search(rf"(?:implied\s+)?(?:ERP|equity risk premium)[^%]{{0,160}}?((?:{MONTHS})\s+\d{{1,2}},\s*20\d\d)[^%]{{0,80}}?(\d{{1,2}}\.\d{{1,2}})\s*%", text, re.I) or \
        re.search(rf"((?:{MONTHS})\s+\d{{1,2}},\s*20\d\d)[^%]{{0,120}}?(?:implied\s+)?(?:ERP|equity risk premium)[^%]{{0,80}}?(\d{{1,2}}\.\d{{1,2}})\s*%", text, re.I)
    if not m:
        raise SourceError("Couldn't read the implied ERP from Damodaran's site")
    when = datetime.strptime(re.sub(r"\s+", " ", m.group(1).replace(",", ", ")).replace(" ,", ","), "%B %d, %Y").date().isoformat()
    return {"value": float(m.group(2)) / 100, "date": when, "source": "Damodaran home page (current implied ERP)", "url": f"{DAMO_ROOT}/{DAMO_FILES['erp'][2]}"}


_DAMO_FAILED: dict[str, tuple[float, str]] = {}   # dataset -> (time of failure, message); retried after 5 minutes


def get_damodaran() -> dict:
    """Everything the DCF needs from Damodaran, each piece cached for a day. Parts that fail are listed in `errors`."""
    loaders = {k: (lambda k=k: _industry_dataset(k)) for k in DAMO_FIELDS}
    loaders.update({"country": _country_dataset, "ratings": _ratings_dataset, "erp": _erp_dataset})
    now, futs, parts, errors = time.time(), {}, {}, {}
    for k, fn in loaders.items():
        failed = _DAMO_FAILED.get(k)
        if failed and now - failed[0] < 300 and peek(f"damo:{k}") is None:
            errors[k] = failed[1]                      # failed moments ago: don't make every visitor wait for it again
            parts[k] = {}
            continue
        futs[k] = POOL.submit(cached, f"damo:{k}", 24 * 3600, fn, True, 300)
    for k, f in futs.items():
        try:
            parts[k] = f.result(timeout=90)
            _DAMO_FAILED.pop(k, None)
        except Exception as exc:
            log.warning("damodaran %s failed: %s", k, exc)
            errors[k] = f"{type(exc).__name__}: {str(exc)[:160]}"
            _DAMO_FAILED[k] = (time.time(), errors[k])
            parts[k] = peek(f"damo:{k}") or {}
    industries: dict[str, dict] = defaultdict(dict)
    for k in DAMO_FIELDS:
        for name, vals in (parts.get(k) or {}).items():
            industries[name].update({f: v for f, v in vals.items() if v is not None})
    ratings = parts.get("ratings") or {}
    if "large" not in ratings:
        ratings = {**DAMO_RATINGS_2026, "note": "January 2026 table (ratings.xls was unavailable)"}
    links = {k: f"{DAMO_ROOT}/{v[2]}" for k, v in DAMO_FILES.items()}
    downloads = {k: f"{DAMO_ROOT}/{v[0]}" for k, v in DAMO_FILES.items()}
    return {"industries": dict(industries), "countries": parts.get("country") or {}, "ratings": ratings, "erp": parts.get("erp") or None,
            "errors": errors, "links": links, "downloads": downloads, "asof": int(time.time() * 1000),
            "source": "Aswath Damodaran, NYU Stern (pages.stern.nyu.edu/~adamodar)"}


# Yahoo Finance industry -> Damodaran industry. Anything not listed is matched by words, then by sector.
YAHOO_TO_DAMO = {
    "advertising agencies": "Advertising", "aerospace & defense": "Aerospace/Defense", "agricultural inputs": "Chemical (Specialty)",
    "airlines": "Air Transport", "airports & air services": "Air Transport", "aluminum": "Metals & Mining", "apparel manufacturing": "Apparel",
    "apparel retail": "Retail (Special Lines)", "asset management": "Investments & Asset Management", "auto & truck dealerships": "Retail (Automotive)",
    "auto manufacturers": "Auto & Truck", "auto parts": "Auto Parts", "banks - diversified": "Bank (Money Center)", "banks - regional": "Banks (Regional)",
    "beverages - brewers": "Beverage (Alcoholic)", "beverages - non-alcoholic": "Beverage (Soft)", "beverages - wineries & distilleries": "Beverage (Alcoholic)",
    "biotechnology": "Drugs (Biotechnology)", "broadcasting": "Broadcasting", "building materials": "Building Materials",
    "building products & equipment": "Building Materials", "business equipment & supplies": "Office Equipment & Services", "capital markets": "Brokerage & Investment Banking",
    "chemicals": "Chemical (Basic)", "coking coal": "Coal & Related Energy", "communication equipment": "Telecom. Equipment", "computer hardware": "Computers/Peripherals",
    "confectioners": "Food Processing", "conglomerates": "Diversified", "consulting services": "Business & Consumer Services", "consumer electronics": "Electronics (Consumer & Office)",
    "copper": "Metals & Mining", "credit services": "Financial Svcs. (Non-bank & Insurance)", "department stores": "Retail (General)", "diagnostics & research": "Healthcare Products",
    "discount stores": "Retail (General)", "drug manufacturers - general": "Drugs (Pharmaceutical)", "drug manufacturers - specialty & generic": "Drugs (Pharmaceutical)",
    "education & training services": "Education", "electrical equipment & parts": "Electrical Equipment", "electronic components": "Electronics (General)",
    "electronic gaming & multimedia": "Software (Entertainment)", "electronics & computer distribution": "Retail (Distributors)", "engineering & construction": "Engineering/Construction",
    "entertainment": "Entertainment", "farm & heavy construction machinery": "Machinery", "farm products": "Farming/Agriculture", "financial conglomerates": "Financial Svcs. (Non-bank & Insurance)",
    "financial data & stock exchanges": "Information Services", "food distribution": "Food Wholesalers", "footwear & accessories": "Shoe",
    "furnishings, fixtures & appliances": "Furn/Home Furnishings", "gambling": "Hotel/Gaming", "gold": "Precious Metals", "grocery stores": "Retail (Grocery and Food)",
    "health information services": "Heathcare Information and Technology", "healthcare plans": "Healthcare Support Services", "home improvement retail": "Retail (Building Supply)",
    "household & personal products": "Household Products", "industrial distribution": "Retail (Distributors)", "information technology services": "Computer Services",
    "infrastructure operations": "Engineering/Construction", "insurance - diversified": "Insurance (General)", "insurance - life": "Insurance (Life)",
    "insurance - property & casualty": "Insurance (Prop/Cas.)", "insurance - reinsurance": "Reinsurance", "insurance - specialty": "Insurance (General)",
    "insurance brokers": "Insurance (General)", "integrated freight & logistics": "Transportation", "internet content & information": "Software (Internet)",
    "internet retail": "Retail (Special Lines)", "leisure": "Recreation", "lodging": "Hotel/Gaming", "lumber & wood production": "Paper/Forest Products",
    "luxury goods": "Apparel", "marine shipping": "Shipbuilding & Marine", "medical care facilities": "Hospitals/Healthcare Facilities", "medical devices": "Healthcare Products",
    "medical distribution": "Healthcare Support Services", "medical instruments & supplies": "Healthcare Products", "metal fabrication": "Steel",
    "mortgage finance": "Financial Svcs. (Non-bank & Insurance)", "oil & gas drilling": "Oilfield Svcs/Equip.", "oil & gas e&p": "Oil/Gas (Production and Exploration)",
    "oil & gas equipment & services": "Oilfield Svcs/Equip.", "oil & gas integrated": "Oil/Gas (Integrated)", "oil & gas midstream": "Oil/Gas Distribution",
    "oil & gas refining & marketing": "Oil/Gas (Integrated)", "other industrial metals & mining": "Metals & Mining", "other precious metals & mining": "Precious Metals",
    "packaged foods": "Food Processing", "packaging & containers": "Packaging & Container", "paper & paper products": "Paper/Forest Products",
    "personal services": "Business & Consumer Services", "pharmaceutical retailers": "Retail (Special Lines)", "pollution & treatment controls": "Environmental & Waste Services",
    "publishing": "Publishing & Newspapers", "railroads": "Transportation (Railroads)", "real estate - development": "Real Estate (Development)",
    "real estate - diversified": "Real Estate (General/Diversified)", "real estate services": "Real Estate (Operations & Services)", "recreational vehicles": "Recreation",
    "reit - diversified": "R.E.I.T.", "reit - healthcare facilities": "R.E.I.T.", "reit - hotel & motel": "R.E.I.T.", "reit - industrial": "R.E.I.T.",
    "reit - mortgage": "R.E.I.T.", "reit - office": "R.E.I.T.", "reit - residential": "R.E.I.T.", "reit - retail": "Retail (REITs)", "reit - specialty": "R.E.I.T.",
    "rental & leasing services": "Business & Consumer Services", "residential construction": "Homebuilding", "resorts & casinos": "Hotel/Gaming",
    "restaurants": "Restaurant/Dining", "scientific & technical instruments": "Electronics (General)", "security & protection services": "Business & Consumer Services",
    "semiconductor equipment & materials": "Semiconductor Equip", "semiconductors": "Semiconductor", "shell companies": "Diversified", "silver": "Precious Metals",
    "software - application": "Software (System & Application)", "software - infrastructure": "Software (System & Application)", "solar": "Green & Renewable Energy",
    "specialty business services": "Business & Consumer Services", "specialty chemicals": "Chemical (Specialty)", "specialty industrial machinery": "Machinery",
    "specialty retail": "Retail (Special Lines)", "staffing & employment services": "Business & Consumer Services", "steel": "Steel",
    "telecom services": "Telecom. Services", "textile manufacturing": "Apparel", "thermal coal": "Coal & Related Energy", "tobacco": "Tobacco",
    "tools & accessories": "Machinery", "travel services": "Hotel/Gaming", "trucking": "Trucking", "uranium": "Metals & Mining",
    "utilities - diversified": "Utility (General)", "utilities - independent power producers": "Power", "utilities - regulated electric": "Utility (General)",
    "utilities - regulated gas": "Oil/Gas Distribution", "utilities - regulated water": "Utility (Water)", "utilities - renewable": "Green & Renewable Energy",
    "waste management": "Environmental & Waste Services",
}
SECTOR_TO_DAMO = {
    "technology": "Software (System & Application)", "communication services": "Telecom. Services", "consumer cyclical": "Retail (General)",
    "consumer defensive": "Food Processing", "healthcare": "Healthcare Products", "financial services": "Financial Svcs. (Non-bank & Insurance)",
    "industrials": "Machinery", "energy": "Oil/Gas (Integrated)", "basic materials": "Chemical (Basic)", "utilities": "Utility (General)", "real estate": "R.E.I.T.",
}
COUNTRY_ALIASES = {"South Korea": "Korea", "Republic of Korea": "Korea", "Czechia": "Czech Republic", "Türkiye": "Turkey", "Russia": "Russia",
                   "Hong Kong SAR": "Hong Kong", "Macao": "Macao", "UAE": "United Arab Emirates", "Ivory Coast": "Cote d'Ivoire"}


def match_damodaran_industry(industry: str | None, sector: str | None, names: list[str]) -> tuple[str | None, str]:
    """Pick the Damodaran industry for a Yahoo industry/sector. Returns (name, how it was chosen)."""
    if not names:
        return None, "Damodaran industry data unavailable"
    lookup = {n.lower(): n for n in names}
    y = (industry or "").strip().lower()
    if y in YAHOO_TO_DAMO and YAHOO_TO_DAMO[y].lower() in lookup:
        return lookup[YAHOO_TO_DAMO[y].lower()], f"Yahoo industry '{industry}'"
    words = {w for w in re.findall(r"[a-z]+", y) if len(w) > 2 and w not in {"and", "the", "services", "other", "general"}}
    if words:
        best = max(names, key=lambda n: (len(words & set(re.findall(r"[a-z]+", n.lower()))), -len(n)))
        if words & set(re.findall(r"[a-z]+", best.lower())):
            return best, f"closest name to Yahoo industry '{industry}'"
    s = (sector or "").strip().lower()
    if s in SECTOR_TO_DAMO and SECTOR_TO_DAMO[s].lower() in lookup:
        return lookup[SECTOR_TO_DAMO[s].lower()], f"Yahoo sector '{sector}'"
    tm = next((n for n in names if n.lower() == "total market (without financials)"), None)
    return tm, "no close match: whole US market (without financials)"


def match_country(country: str | None, countries: dict) -> str | None:
    if not countries:
        return None
    c = COUNTRY_ALIASES.get(country or "", country or "United States")
    if c in countries:
        return c
    low = {k.lower(): k for k in countries}
    return low.get(c.lower()) or next((k for k in countries if k.lower().startswith(c.lower()[:6])), None)


# =============================================================================
# Economic calendar (FRED schedule with key; published Fed/BLS dates otherwise)
# =============================================================================
RELEASES = [  # regex on FRED release name -> code, label, ET time
    (r"^consumer price index$", "CPI", "Consumer Price Index", "08:30"), (r"^employment situation$", "NFP", "Jobs report (Employment Situation)", "08:30"),
    (r"^producer price index$", "PPI", "Producer Price Index", "08:30"), (r"^personal income and outlays$", "PCE", "PCE inflation & spending", "08:30"),
    (r"^gross domestic product$", "GDP", "GDP", "08:30"), (r"^advance monthly sales for retail and food services$", "RETAIL", "Retail sales", "08:30"),
    (r"^job openings and labor turnover survey$", "JOLTS", "JOLTS job openings", "10:00"), (r"industrial production and capacity utilization", "IP", "Industrial production", "09:15"),
    (r"^surveys of consumers$", "UMICH", "UMich consumer sentiment", "10:00"), (r"^new residential construction$", "HOUSING", "Housing starts", "08:30"),
    (r"^employment cost index$", "ECI", "Employment Cost Index", "08:30"), (r"^fomc press release$", "FOMC", "FOMC rate decision", "14:00"),
    (r"^unemployment insurance weekly claims", "CLAIMS", "Initial jobless claims", "08:30"),
]
KNOWN_EVENTS = [  # published schedules (Federal Reserve 2026–27; BLS 2026)
    ("2026-10-28", "14:00", "FOMC", "FOMC rate decision"), ("2026-12-09", "14:00", "FOMC", "FOMC rate decision + projections"),
    ("2027-01-27", "14:00", "FOMC", "FOMC rate decision"), ("2027-03-17", "14:00", "FOMC", "FOMC rate decision + projections"),
    ("2027-04-28", "14:00", "FOMC", "FOMC rate decision"), ("2027-06-09", "14:00", "FOMC", "FOMC rate decision + projections"),
    ("2027-07-28", "14:00", "FOMC", "FOMC rate decision"), ("2027-09-15", "14:00", "FOMC", "FOMC rate decision + projections"),
    ("2027-10-27", "14:00", "FOMC", "FOMC rate decision"), ("2027-12-08", "14:00", "FOMC", "FOMC rate decision + projections"),
    ("2026-10-30", "08:30", "ECI", "Employment Cost Index Q3"), ("2026-12-04", "08:30", "NFP", "Jobs report (November)"),
    ("2026-12-10", "08:30", "CPI", "Consumer Price Index (November)"), ("2026-12-15", "08:30", "PPI", "Producer Price Index (November)"),
]


def _et_to_utc(d: str, hhmm: str) -> int:
    y, m, dd = map(int, d.split("-"))
    hh, mm = map(int, hhmm.split(":"))
    mar = date(y, 3, 8 + (6 - date(y, 3, 8).weekday()) % 7)        # 2nd Sunday of March
    nov = date(y, 11, 1 + (6 - date(y, 11, 1).weekday()) % 7)      # 1st Sunday of November
    off = 4 if mar <= date(y, m, dd) < nov else 5
    return int(datetime(y, m, dd, hh, mm, tzinfo=timezone.utc).timestamp() * 1000) + off * 3600 * 1000


def get_calendar() -> dict:
    def load():
        events, src = [], "Published Fed and BLS schedules"
        if FRED_KEY:
            try:
                r = requests.get("https://api.stlouisfed.org/fred/releases/dates", headers=UA, timeout=12, params={
                    "api_key": FRED_KEY, "file_type": "json", "include_release_dates_with_no_data": "true", "sort_order": "asc", "limit": 1000,
                    "realtime_start": (date.today() - timedelta(days=2)).isoformat(), "realtime_end": (date.today() + timedelta(days=90)).isoformat()})
                r.raise_for_status()
                for row in r.json().get("release_dates", []):
                    name = re.sub(r"\s+", " ", str(row.get("release_name", "")).lower()).strip()
                    for pat, code, label, tm in RELEASES:
                        if re.search(pat, name):
                            events.append({"date": row["date"], "time": tm, "code": code, "label": label, "src": "FRED release calendar", "est": False})
                            break
                src = "FRED release calendar"
            except Exception as exc:
                log.info("FRED calendar unavailable: %s", exc)
        have = {(e["code"], e["date"]) for e in events}
        for d, tm, code, label in KNOWN_EVENTS:
            if (code, d) not in have:
                events.append({"date": d, "time": tm, "code": code, "label": label, "src": "Federal Reserve / BLS schedule", "est": False})
        today = date.today()
        if not FRED_KEY:   # conventions fill the gaps, marked as estimates
            for k in range(4):
                y, m = today.year + (today.month - 1 + k) // 12, (today.month - 1 + k) % 12 + 1
                d = date(y, m, 1)
                while d.weekday() != 4:
                    d += timedelta(days=1)
                if not any(e["code"] == "NFP" and e["date"][:7] == d.isoformat()[:7] for e in events):
                    events.append({"date": d.isoformat(), "time": "08:30", "code": "NFP", "label": "Jobs report", "src": "First-Friday convention", "est": True})
            d = today
            while d < today + timedelta(days=60):
                if d.weekday() == 3:
                    events.append({"date": d.isoformat(), "time": "08:30", "code": "CLAIMS", "label": "Initial jobless claims", "src": "Weekly (Thursday)", "est": True})
                d += timedelta(days=1)
        for e in events:
            e["ts"] = _et_to_utc(e["date"], e["time"])
        events = [e for e in events if e["ts"] > (time.time() - 2 * 86400) * 1000]
        events.sort(key=lambda e: e["ts"])
        return {"events": events[:80], "source": src, "fredKey": bool(FRED_KEY)}
    return cached("calendar", 6 * 3600, load)


# =============================================================================
# Universe (screener, heatmap, comparables)
# =============================================================================
def _rsi(c: np.ndarray, n=14) -> float | None:
    if len(c) < n + 2:
        return None
    d = np.diff(c)
    up, dn = np.clip(d, 0, None), np.clip(-d, 0, None)
    au, ad = up[:n].mean(), dn[:n].mean()
    for i in range(n, len(d)):
        au, ad = (au * (n - 1) + up[i]) / n, (ad * (n - 1) + dn[i]) / n
    return 100.0 if ad == 0 else float(100 - 100 / (1 + au / ad))


def get_universe() -> dict:
    def prices():
        df = _download(UNIVERSE + [BENCH], period="1y", interval="1d")
        out = {}
        b = _frame_for(df, BENCH, 2)["Close"].dropna() if not _frame_for(df, BENCH, 2).empty else pd.Series(dtype=float)
        br = b.pct_change().dropna()
        for s in UNIVERSE:
            f = _frame_for(df, s, 2)
            if f.empty:
                continue
            c = f["Close"].dropna()
            if len(c) < 60:
                continue
            r = c.pct_change().dropna()
            j = r.index.intersection(br.index)
            beta = float(np.cov(r[j], br[j])[0, 1] / np.var(br[j], ddof=1)) if len(j) > 60 else None
            arr = c.values
            out[s] = {"mom1m": float(arr[-1] / arr[-22] - 1), "mom6m": float(arr[-1] / arr[-127] - 1) if len(arr) > 127 else None,
                      "mom12m": float(arr[-1] / arr[0] - 1), "vol": float(r.std() * math.sqrt(252)), "beta": beta, "rsi": _rsi(arr),
                      "above50": bool(arr[-1] > arr[-50:].mean()), "above200": bool(arr[-1] > arr[-200:].mean()) if len(arr) >= 200 else None}
        return out

    def load():
        px = cached("universe:prices", 3600, prices)
        infos = {}
        futs = {s: POOL.submit(get_info, s) for s in UNIVERSE}
        for s, f in futs.items():
            try:
                infos[s] = f.result(timeout=60)
            except Exception:
                infos[s] = {}
        quotes = get_quotes(UNIVERSE)
        rows = []
        for s in UNIVERSE:
            i, p, q = infos.get(s) or {}, px.get(s) or {}, quotes.get(s) or {}
            price = q.get("last") or i.get("currentPrice") or i.get("regularMarketPrice")
            cap = i.get("marketCap")
            rows.append({"sym": s, "name": i.get("shortName") or s, "sector": i.get("sector") or "—", "industry": i.get("industry") or "—",
                         "price": price, "chg": q.get("chgPct"), "cap": cap / 1e9 if cap else None,
                         "pe": i.get("trailingPE"), "fpe": i.get("forwardPE"), "evebitda": i.get("enterpriseToEbitda") if (i.get("enterpriseToEbitda") or 0) > 0 else None,
                         "evsales": i.get("enterpriseToRevenue"), "ps": i.get("priceToSalesTrailing12Months"), "pb": i.get("priceToBook"),
                         "growth": i.get("revenueGrowth"), "margin": i.get("operatingMargins"),
                         "fcfy": (i.get("freeCashflow") / cap) if (i.get("freeCashflow") and cap) else None,
                         "dy": (i.get("dividendRate") or 0) / price if price else None,
                         "tgtup": (i.get("targetMeanPrice") / price - 1) if (i.get("targetMeanPrice") and price) else None, **p})
        return {"rows": rows, "asof": int(time.time() * 1000), "complete": sum(1 for r in rows if r["cap"]) > len(rows) * 0.8}
    return cached("universe", 1800, load)


# =============================================================================
# News, crypto book, search
# =============================================================================
def get_news(sym: str) -> list[dict]:
    def load():
        items = []
        try:
            for n in (yf.Ticker(sym).news or [])[:15]:
                c = n.get("content", n)
                url = (c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else c.get("link")
                items.append({"title": c.get("title"), "url": url or n.get("link"), "site": (c.get("provider") or {}).get("displayName") if isinstance(c.get("provider"), dict) else n.get("publisher"),
                              "date": c.get("pubDate") or n.get("providerPublishTime"), "summary": (c.get("summary") or "")[:280]})
        except Exception as exc:
            log.info("yahoo news failed for %s: %s", sym, exc)
        name = (get_info(sym) or {}).get("shortName") or sym
        try:
            items += google_news(f'"{name}" when:7d' if name != sym else f"{sym} stock when:7d", 15)
        except Exception as exc:
            log.info("google news failed for %s: %s", sym, exc)
        return _dedupe(items)[:25]
    return cached(f"news:{sym}", 900, load)


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        k = re.sub(r"\W+", " ", (it.get("title") or "").lower()).strip()[:70]
        if it.get("title") and it.get("url") and k not in seen:
            seen.add(k)
            out.append(it)
    return out


def google_news(query: str, n: int = 20) -> list[dict]:
    """Headlines from Google News RSS search: [{title, url, site, date (RSS text), ts (ms)}], newest first."""
    r = http_get("https://news.google.com/rss/search", params={"q": query, "hl": "en-US", "gl": "US", "ceid": "US:en"}, timeout=12, tries=2)
    out = []
    for it in ET.fromstring(r.text).findall(".//item")[: n * 2]:
        src = it.find("source")
        title = _html.unescape(it.findtext("title") or "").strip()
        site = ((src.text if src is not None else "") or "Google News").strip()
        if site and title.endswith(" - " + site):
            title = title[: -len(site) - 3]
        pub = it.findtext("pubDate") or ""
        try:
            ts = int(parsedate_to_datetime(pub).timestamp() * 1000)
        except (TypeError, ValueError):
            ts = None
        out.append({"title": title, "url": it.findtext("link"), "site": site, "date": pub, "ts": ts, "summary": ""})
    out.sort(key=lambda x: x["ts"] or 0, reverse=True)
    return _dedupe(out)[:n]


# Market news by theme (NEWS screen). Each theme lists the prices it tends to move,
# so the screen can show headlines next to the market's reaction.
NEWS_THEMES = [
    ("markets", "Markets", '"stock market" OR "Wall Street" OR "S&P 500" OR Nasdaq when:1d', ["^GSPC", "^NDX", "^RUT", "^VIX"]),
    ("fed", "Fed & rates", '"Federal Reserve" OR "Treasury yields" OR "rate cut" OR "rate hike" OR Powell when:2d', ["^IRX", "^TNX", "^TYX", "DX-Y.NYB"]),
    ("economy", "Inflation & economy", 'inflation OR CPI OR "jobs report" OR payrolls OR GDP OR recession when:3d', ["^TNX", "^GSPC", "GC=F", "DX-Y.NYB"]),
    ("geopolitics", "Geopolitics & trade", 'tariffs OR sanctions OR geopolitical OR "trade war" OR conflict markets when:2d', ["CL=F", "GC=F", "^VIX", "DX-Y.NYB"]),
    ("energy", "Energy & commodities", '"oil prices" OR OPEC OR "natural gas" OR "gold price" OR copper when:2d', ["CL=F", "BZ=F", "NG=F", "GC=F", "HG=F"]),
    ("asia", "China & Asia", '"China economy" OR yuan OR "Hang Seng" OR Nikkei OR "Bank of Japan" when:2d', ["^HSI", "^N225", "CNY=X", "JPY=X"]),
    ("tech", "Tech & AI", 'Nvidia OR "artificial intelligence" OR semiconductor OR "big tech" stocks when:2d', ["NVDA", "MSFT", "AAPL", "^NDX"]),
    ("earnings", "Earnings", 'earnings results guidance quarter when:2d', ["^GSPC", "^NDX", "^RUT"]),
    ("crypto", "Crypto", 'bitcoin OR ethereum OR "crypto market" when:1d', ["BTC-USD", "ETH-USD", "SOL-USD"]),
    ("mongolia", "Mongolia", 'Mongolia economy OR tugrik OR "Bank of Mongolia" OR "Oyu Tolgoi" OR "Mongolian coal" when:14d', ["MNT=X", "HG=F", "CNY=X"]),
]


def get_headlines() -> dict:
    """All news themes (each cached 10 min). A theme that fails comes back with an error, not an exception."""
    def one(key, query):
        return cached(f"theme:{key}", 600, lambda: google_news(query, 20), keep_empty_for=120)
    futs = {key: POOL.submit(one, key, q) for key, _, q, _ in NEWS_THEMES}
    themes = []
    for key, label, _, watch in NEWS_THEMES:
        try:
            items, err = futs[key].result(timeout=30), None
        except Exception as exc:
            log.info("news theme %s failed: %s", key, exc)
            items = peek(f"theme:{key}") or []
            err = "Google News didn't answer; showing the last headlines we had." if items else "Google News didn't answer. Try again in a minute."
        if not items and not err:
            err = "No headlines for this theme right now."
        themes.append({"key": key, "label": label, "watch": watch, "items": items, "error": err})
    return {"themes": themes, "asof": int(time.time() * 1000), "source": "Google News"}


def binance_symbol(sym: str) -> str | None:
    m = re.match(r"^([A-Z0-9]{2,10})-USD$", sym)
    return m.group(1) + "USDT" if m else None


def get_book(sym: str) -> dict:
    bs = binance_symbol(sym)
    if not bs:
        return {"level1": True}

    def load():
        base = "https://data-api.binance.vision/api/v3"
        d = requests.get(f"{base}/depth", params={"symbol": bs, "limit": 20}, headers=UA, timeout=6)
        t = requests.get(f"{base}/trades", params={"symbol": bs, "limit": 40}, headers=UA, timeout=6)
        d.raise_for_status()
        t.raise_for_status()
        dj, tj = d.json(), t.json()
        return {"pair": bs, "bids": [[float(p), float(q)] for p, q in dj.get("bids", [])], "asks": [[float(p), float(q)] for p, q in dj.get("asks", [])],
                "trades": [{"t": x["time"], "p": float(x["price"]), "q": float(x["qty"]), "side": "S" if x.get("isBuyerMaker") else "B"} for x in reversed(tj)],
                "src": "Binance public market data"}
    return cached(f"book:{bs}", 2, load)


def search_symbols(q: str) -> list[dict]:
    def load():
        res = yf.Search(q, max_results=10, news_count=0, lists_count=0, recommended=0, raise_errors=False)
        out = []
        for r in (res.quotes or [])[:10]:
            if r.get("symbol"):
                out.append({"sym": r["symbol"], "name": r.get("shortname") or r.get("longname") or "", "type": r.get("quoteType") or "", "exch": r.get("exchDisp") or r.get("exchange") or ""})
        return out
    return cached(f"search:{q.lower()}", 3600, load)


# =============================================================================
# Routes
# =============================================================================
def guard(fn):
    try:
        return fn()
    except HTTPException:
        raise
    except SourceError as exc:
        log.warning("request failed: %s", exc)
        raise HTTPException(502, str(exc))
    except Exception as exc:
        log.warning("request failed: %s: %s", type(exc).__name__, exc)
        if "ratelimit" in type(exc).__name__.lower() or "too many requests" in str(exc).lower():
            raise HTTPException(503, "Yahoo Finance is rate-limiting this server right now. Cached data is still served; new data returns in a few minutes.")
        raise HTTPException(502, f"Data provider error ({type(exc).__name__}). The source may be down or rate-limiting; try again in a minute.")


@app.get("/", response_class=HTMLResponse)
def page():
    if PAGE.exists():                 # development: serve the freshly built file
        return FileResponse(PAGE, media_type="text/html")
    if PAGE_HTML:                     # single-file build (agula.py): page is embedded below
        return HTMLResponse(PAGE_HTML)
    return HTMLResponse("<h1>agula_terminal.html is missing</h1><p>Run python build.py, or deploy the single-file agula.py.</p>", status_code=500)


@app.get("/health")
def health():
    return {"status": "ok", "app": "Agula Terminal", "version": VERSION, "fredKey": bool(FRED_KEY),
            "cached": len(_CACHE), "quotes": len(_QUOTES), "stats": dict(STATS), "universe": len(UNIVERSE)}


@app.get("/api/quotes")
def api_quotes(symbols: str = Query(...)):
    syms = syms_ok(symbols, 120)
    if not syms:
        raise HTTPException(400, "No valid symbols.")
    return {"quotes": guard(lambda: get_quotes(syms)), "ttl": QUOTE_TTL}


@app.get("/api/history")
def api_history(symbol: str, tf: str = "1D"):
    s = sym_ok(symbol)
    if tf not in TF:
        raise HTTPException(400, "tf must be one of " + ", ".join(TF))
    bars = guard(lambda: get_history(s, tf))
    if not bars:
        raise HTTPException(404, f"No price history for {s}. Check the symbol (Yahoo format, e.g. AAPL, ^GSPC, EURUSD=X, GC=F, BTC-USD).")
    return {"symbol": s, "tf": tf, "bars": bars}


@app.get("/api/sparks")
def api_sparks(symbols: str):
    syms = syms_ok(symbols, 80)

    def load():
        df = _download(syms, period="1d", interval="5m")
        out = {}
        for s in syms:
            f = _frame_for(df, s, len(syms))
            if not f.empty and "Close" in f:
                c = f["Close"].dropna()
                k = 0.1 if (s in RATE_SYMS and len(c) and c.iloc[-1] > 20) else 1
                out[s] = [round(float(x) * k, 6) for x in c.values[-90:]]
        return out
    return {"sparks": guard(lambda: cached("sparks:" + ",".join(sorted(syms)), 120, load))}


@app.get("/api/meta")
def api_meta(symbols: str):
    syms = syms_ok(symbols, 40)
    futs = {s: POOL.submit(get_info, s) for s in syms}
    out = {}
    for s, f in futs.items():
        try:
            i = f.result(timeout=40)
        except Exception:
            i = {}
        if i:
            out[s] = {"name": i.get("shortName") or i.get("longName") or s, "type": i.get("quoteType"), "currency": i.get("currency"),
                      "exchange": i.get("fullExchangeName") or i.get("exchange"), "sector": i.get("sector"), "industry": i.get("industry")}
    return {"meta": out}


@app.get("/api/profile")
def api_profile(symbol: str):
    s = sym_ok(symbol)
    info = guard(lambda: get_info(s))
    if not info:
        raise HTTPException(404, f"Yahoo Finance has no profile for {s}.")
    return {"symbol": s, "info": info}


@app.get("/api/fundamentals")
def api_fundamentals(symbol: str):
    s = sym_ok(symbol)
    f = guard(lambda: get_fundamentals(s))
    if not f:
        raise HTTPException(404, f"No annual financial statements for {s}. DCF works for operating companies (e.g. AAPL, MSFT, KO).")
    return f


@app.get("/api/options")
def api_options(symbol: str):
    s = sym_ok(symbol)
    src = guard(lambda: option_source(s))
    return {"symbol": s, "expirations": src["expirations"], "status": src["status"], "source": src["source"]}


@app.get("/api/options/chain")
def api_chain(symbol: str, expiry: str):
    s = sym_ok(symbol)
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", expiry):
        raise HTTPException(400, "expiry must be YYYY-MM-DD")
    return guard(lambda: get_chain(s, expiry))


@app.get("/api/options/surface")
def api_surface(symbol: str, spot: float):
    s = sym_ok(symbol)
    return {"symbol": s, "slices": guard(lambda: cached(f"surface:{s}:{round(spot, 2)}", 600, lambda: get_surface(s, spot)))}


@app.get("/api/curve")
def api_curve():
    return guard(get_curve)


@app.get("/api/macro")
def api_macro():
    return {"indicators": guard(get_macro), "source": "FRED (Federal Reserve Bank of St. Louis)"}


@app.get("/api/calendar")
def api_calendar():
    return guard(get_calendar)


@app.get("/api/fx/rates")
def api_fx_rates():
    return {"rates": guard(get_fx_rates)}


@app.get("/api/universe")
def api_universe():
    return guard(get_universe)


@app.get("/api/news")
def api_news(symbol: str):
    s = sym_ok(symbol)
    return {"symbol": s, "news": guard(lambda: get_news(s))}


@app.get("/api/damodaran")
def api_damodaran(industry: str = "", sector: str = "", country: str = ""):
    """Damodaran's data plus the industry and country matched to a company (from Yahoo's industry, sector and country)."""
    d = guard(get_damodaran)
    name, how = match_damodaran_industry(industry[:80], sector[:80], sorted(d["industries"]))
    ctry = match_country(country[:60], d["countries"])
    return {**d, "match": {"industry": name, "how": how, "country": ctry, "us": "United States" if "United States" in d["countries"] else None}}


@app.post("/api/dcf/xlsx")
async def api_dcf_xlsx(request: Request):
    """Build the DCF Excel model (formulas, charts, tables) from the model shown in the browser."""
    raw = await request.body()
    if len(raw) > 3_000_000:
        raise HTTPException(413, "Model too large to export.")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "The export request wasn't valid JSON.")
    try:
        data = await asyncio.to_thread(build_dcf_workbook, payload)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("xlsx export failed")
        raise HTTPException(500, f"Couldn't build the Excel file ({type(exc).__name__}). CSV export still works.")
    sym = re.sub(r"[^A-Za-z0-9._-]", "", str((payload.get("meta") or {}).get("sym") or "model"))[:20] or "model"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{sym}_DCF_model.xlsx"', "Cache-Control": "no-store"})


@app.get("/api/headlines")
def api_headlines():
    return guard(get_headlines)


@app.get("/api/book")
def api_book(symbol: str):
    s = sym_ok(symbol)
    return guard(lambda: get_book(s))


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1, max_length=40)):
    return {"results": guard(lambda: search_symbols(q.strip()))}


# =============================================================================
# DCF Excel model (XlsxWriter): live formulas, native charts, formatted tables
# =============================================================================
# The browser posts the model it shows; this builds a workbook whose formulas
# reproduce that model (each formula also stores the browser's value, so the
# file reads correctly even before Excel recalculates). Blue cells are inputs.
def _q(sheet: str) -> str:
    return f"'{sheet}'" if re.search(r"[^A-Za-z0-9_]", sheet) else sheet


def _cell(r: int, c: int, abs_: bool = False) -> str:
    from xlsxwriter.utility import xl_rowcol_to_cell
    return xl_rowcol_to_cell(r, c, row_abs=abs_, col_abs=abs_)


def _f(x, default=None):
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


class _DcfBook:
    MONEY, PCT, PCT2, MULT, NUM2, PRICE, YEAR = "#,##0;[Red]-#,##0", "0.0%", "0.00%", '0.00"x"', "0.00", "#,##0.00", "0"

    def __init__(self, p: dict):
        import xlsxwriter
        self.p, self.A = p, p.get("A") or {}
        self.buf = io.BytesIO()
        self.wb = xlsxwriter.Workbook(self.buf, {"in_memory": True, "nan_inf_to_errors": True, "strings_to_numbers": False, "strings_to_formulas": True})
        self.wb.set_properties({"title": f"DCF model {p['meta'].get('sym')}", "author": "Agula Terminal", "comments": "Generated by Agula Terminal"})
        self.fmts: dict = {}
        self.names: dict = {}
        base = {"font_name": "Calibri", "font_size": 10}
        self.F = lambda **k: self._fmt(base, k)

    def _fmt(self, base, k):
        key = tuple(sorted({**base, **k}.items()))
        if key not in self.fmts:
            self.fmts[key] = self.wb.add_format({**base, **k})
        return self.fmts[key]

    # styles
    def title(self): return self.F(bold=True, font_size=15, font_color="#1F2937")
    def sub(self): return self.F(italic=True, font_color="#6B7280")
    def head(self): return self.F(bold=True, font_color="#FFFFFF", bg_color="#1F3A5F", border=1, border_color="#1F3A5F", align="center", valign="vcenter", text_wrap=True)
    def sect(self): return self.F(bold=True, font_color="#1F3A5F", bottom=2, bottom_color="#1F3A5F")
    def lab(self, bold=False, indent=0): return self.F(bold=bold, indent=indent)
    def inp(self, nf): return self.F(num_format=nf, font_color="#1D4ED8", bg_color="#FFF7D6", border=1, border_color="#E5D9A8")
    def calc(self, nf, bold=False, top=False): return self.F(num_format=nf, bold=bold, top=1 if top else 0, top_color="#9CA3AF")
    def link(self, nf): return self.F(num_format=nf, font_color="#047857")
    def key(self, nf): return self.F(num_format=nf, bold=True, font_size=12, font_color="#1F3A5F", bg_color="#E8F0FB", border=1, border_color="#9DB5D9")
    def note(self): return self.F(font_color="#6B7280", italic=True, text_wrap=True, valign="top")

    def name(self, nm: str, sheet: str, r: int, c: int):
        self.wb.define_name(nm, f"={_q(sheet)}!{_cell(r, c, True)}")
        self.names[nm] = (sheet, r, c)

    def ref(self, sheet: str, r: int, c: int, abs_=True) -> str:
        return f"{_q(sheet)}!{_cell(r, c, abs_)}"

    def build(self) -> bytes:
        p, A = self.p, self.A
        self.hist = sorted([y for y in p.get("hist") or [] if _f(y.get("revenue"))], key=lambda y: y["year"])
        self.rows = p.get("rows") or []
        self.N = len(self.rows)
        # sheet order shown to the user
        self.ws = {n: self.wb.add_worksheet(n) for n in ("Summary", "Inputs", "Cost of capital", "DCF", "Drivers", "Sensitivity", "Scenarios", "Historicals", "Peers & industry", "Damodaran", "Chart data", "Notes")}
        for nm, ws in self.ws.items():
            ws.hide_gridlines(2)
            ws.set_zoom(90)
            ws.set_landscape()
            ws.set_paper(9)                      # A4
            ws.fit_to_pages(1, 0)                # one page wide, as many tall as needed
            ws.set_margins(left=0.4, right=0.4, top=0.5, bottom=0.5)
            ws.set_footer(f"&L&8Agula Terminal · {self.p['meta'].get('sym')} DCF&R&8&A · page &P of &N")
        self.ws["Summary"].activate()
        self.sheet_historicals()
        self.sheet_damodaran()
        self.sheet_drivers()
        self.sheet_inputs()
        self.sheet_coc()
        self.sheet_dcf()
        self.sheet_sensitivity()
        self.sheet_scenarios()
        self.sheet_peers()
        self.sheet_chartdata()
        self.sheet_summary()
        self.sheet_notes()
        self.wb.close()
        return self.buf.getvalue()

    # ------------------------------------------------------------------ Historicals (Excel table)
    def sheet_historicals(self):
        ws, M = self.ws["Historicals"], 1e6
        ws.write(0, 0, "Historical financials ($ millions)", self.title())
        ws.write(1, 0, f"Source: {self.p['meta'].get('source') or 'Yahoo Finance'}. Invested capital = book equity + debt − cash.", self.sub())
        cols = [("Fiscal year", "year", self.YEAR, 1), ("Revenue", "revenue", self.MONEY, M), ("Gross profit", "grossProfit", self.MONEY, M), ("EBIT", "ebit", self.MONEY, M),
                ("D&A", "da", self.MONEY, M), ("Capex", "capex", self.MONEY, M), ("Interest expense", "interest", self.MONEY, M), ("Pre-tax income", "pretax", self.MONEY, M),
                ("Effective tax rate", "taxRate", self.PCT, 1), ("Net income", "netIncome", self.MONEY, M), ("Operating cash flow", "ocf", self.MONEY, M), ("Free cash flow", "fcf", self.MONEY, M),
                ("Change in working capital (cash flow)", "dWC", self.MONEY, M), ("Book equity", "equityBook", self.MONEY, M), ("Total debt", "debtBook", self.MONEY, M), ("Cash & investments", "cashBook", self.MONEY, M)]
        self.hcol = {k: j for j, (_, k, _, _) in enumerate(cols)}
        n = len(cols)
        self.hcol.update({"ic": n, "margin": n + 1, "growth": n + 2})
        r0 = 3
        self.hrow = {}
        data = []
        for i, y in enumerate(self.hist):
            r = r0 + 1 + i
            self.hrow[y["year"]] = r
            row = []
            for _, k, _, sc in cols:
                v = _f(y.get(k))
                row.append(None if v is None else (v / sc if sc != 1 else v))
            eq, de, ca = (_cell(r, self.hcol[k]) for k in ("equityBook", "debtBook", "cashBook"))
            row.append(f"=IF(AND(ISNUMBER({eq}),ISNUMBER({de}),ISNUMBER({ca})),{eq}+{de}-{ca},\"\")")
            row.append(f"=IF(ISNUMBER({_cell(r, 3)}),{_cell(r, 3)}/{_cell(r, 1)},\"\")")
            row.append(f"={_cell(r, 1)}/{_cell(r - 1, 1)}-1" if i else "")
            data.append(row)
        headers = [{"header": h, "format": self.F(num_format=nf)} for h, _, nf, _ in cols] + [
            {"header": "Invested capital", "format": self.F(num_format=self.MONEY)}, {"header": "EBIT margin", "format": self.F(num_format=self.PCT)}, {"header": "Revenue growth", "format": self.F(num_format=self.PCT)}]
        if data:
            ws.add_table(r0, 0, r0 + len(data), n + 2, {"data": data, "columns": headers, "style": "Table Style Medium 2", "name": "Historicals", "autofilter": False})
        ws.set_column(0, 0, 11)
        ws.set_column(1, n + 2, 14)
        ws.freeze_panes(r0 + 1, 1)

    def H(self, year: int, key: str) -> str | None:
        r = self.hrow.get(year)
        return None if r is None else self.ref("Historicals", r, self.hcol[key], False)

    # ------------------------------------------------------------------ Damodaran data
    def sheet_damodaran(self):
        ws, d = self.ws["Damodaran"], self.p.get("damodaran") or {}
        ws.write(0, 0, "Damodaran data used (NYU Stern, pages.stern.nyu.edu/~adamodar)", self.title())
        ws.write(1, 0, "Industry averages are January data for US companies; the implied equity risk premium is updated monthly.", self.sub())
        self.dref = {}
        if not d:
            ws.write(3, 0, "Damodaran's data was unavailable when this model was built; fallbacks were used (see Inputs).", self.note())
            self.rating_rng = None
            return
        ind, mk = d.get("industry") or {}, d.get("market") or {}
        fields = [("Number of firms", "firms", "#,##0"), ("Levered beta", "beta", self.NUM2), ("Debt / equity", "de", self.PCT), ("Unlevered beta", "betaU", self.NUM2),
                  ("Unlevered beta corrected for cash", "betaUCash", self.NUM2), ("Effective tax rate", "taxEffective", self.PCT), ("Cost of equity", "ke", self.PCT2),
                  ("Pre-tax cost of debt", "kdPre", self.PCT2), ("Debt / (debt + equity)", "debtRatio", self.PCT), ("Cost of capital", "wacc", self.PCT2),
                  ("Gross margin", "grossMargin", self.PCT), ("Pre-tax operating margin", "opMargin", self.PCT), ("Net margin", "netMargin", self.PCT), ("EBITDA / sales", "ebitdaMargin", self.PCT),
                  ("Net capex / sales", "netCapexSales", self.PCT), ("Sales / invested capital", "salesToCapital", self.NUM2), ("Non-cash working capital / sales", "nwcSales", self.PCT),
                  ("Return on capital", "roc", self.PCT), ("Revenue growth, last 5 years", "revGrowthHist", self.PCT), ("Expected revenue growth, next 5 years", "revGrowthExp", self.PCT)]
        ws.write_row(3, 0, ["Measure", d.get("industryName") or "Industry", "Total market"], self.head())
        for i, (lab, k, nf) in enumerate(fields):
            r = 4 + i
            ws.write(r, 0, lab, self.lab())
            for j, src in ((1, ind), (2, mk)):
                v = _f(src.get(k))
                ws.write(r, j, v if v is not None else "n/a", self.F(num_format=nf))
            self.dref[k] = (r, 1)
        r = 4 + len(fields) + 1
        ws.write(r, 0, "Country", self.sect())
        c, us = d.get("country") or {}, d.get("us") or {}
        ws.write_row(r + 1, 0, ["Measure", c.get("name") or "Country", "United States"], self.head())
        for i, (lab, k, nf) in enumerate([("Moody's rating", "rating", "@"), ("Default spread", "defaultSpread", self.PCT2), ("Country risk premium", "crp", self.PCT2), ("Equity risk premium", "erp", self.PCT2), ("Corporate tax rate", "tax", self.PCT)]):
            ws.write(r + 2 + i, 0, lab, self.lab())
            for j, src in ((1, c), (2, us)):
                v = src.get(k)
                ws.write(r + 2 + i, j, v if isinstance(v, str) else (_f(v) if _f(v) is not None else "n/a"), self.F(num_format=nf))
        r += 9
        erp = d.get("erp") or {}
        ws.write(r, 0, "Implied equity risk premium (S&P 500)", self.sect())
        ws.write(r + 1, 0, "Value", self.lab())
        ws.write(r + 1, 1, _f(erp.get("value")), self.F(num_format=self.PCT2))
        ws.write(r + 2, 0, "As of", self.lab())
        ws.write(r + 2, 1, str(erp.get("date") or ""))
        ws.write(r + 3, 0, "Source", self.lab())
        ws.write(r + 3, 1, str(erp.get("source") or ""))
        r += 5
        # synthetic rating table actually used (sorted by lower bound for LOOKUP)
        ratings = d.get("ratings") or {}
        A = self.A
        mcap = (_f(A.get("price"), 0) or 0) * (_f(A.get("shares"), 0) or 0)
        key = "financial" if A.get("financial") and ratings.get("financial") else "small" if mcap < 5e9 and ratings.get("small") else "large"
        tab = sorted(ratings.get(key) or [], key=lambda x: x[0])
        ws.write(r, 0, f"Interest coverage → rating → default spread ({'financial firms' if key == 'financial' else 'smaller firms' if key == 'small' else 'large non-financial firms'})", self.sect())
        if tab:
            ws.add_table(r + 1, 0, r + 1 + len(tab), 3, {"data": [[t[0], t[1], t[2], t[3]] for t in tab], "name": "SyntheticRatings", "style": "Table Style Light 9", "autofilter": False,
                                                       "columns": [{"header": "Coverage greater than", "format": self.F(num_format="0.00")}, {"header": "Up to", "format": self.F(num_format="0.00")},
                                                                   {"header": "Rating"}, {"header": "Default spread", "format": self.F(num_format=self.PCT2)}]})
            self.rating_rng = (r + 2, r + 1 + len(tab))
        else:
            self.rating_rng = None
        r += len(tab) + 3
        links = d.get("links") or {}
        ws.write(r, 0, "Source pages", self.sect())
        for i, (k, u) in enumerate(sorted(links.items())):
            ws.write_url(r + 1 + i, 0, u, string=f"{k}: {u}")
        ws.set_column(0, 0, 42)
        ws.set_column(1, 2, 22)
        ws.set_column(3, 3, 16)

    def D(self, k: str) -> str | None:
        rc = self.dref.get(k)
        return None if not rc else self.ref("Damodaran", *rc)

    # ------------------------------------------------------------------ Drivers (history -> assumptions)
    def sheet_drivers(self):
        ws, A = self.ws["Drivers"], self.A
        ws.write(0, 0, "Forecast drivers derived from history", self.title())
        ws.write(1, 0, "Each method column is an Excel formula over the historical ratios to its left (clamped to a sane range). The 'Used' column feeds the Inputs sheet; blue = typed by hand.", self.sub())
        drivers = self.p.get("drivers") or []
        years = sorted({h["year"] for d in drivers for h in d.get("hist") or []})
        meth = ["avg", "wavg", "median", "latest", "trend", "cagr", "industry"]
        mlab = {"avg": "Average", "wavg": "Recent-weighted", "median": "Median", "latest": "Latest", "trend": "Linear trend", "cagr": "CAGR", "industry": "Industry (Damodaran)"}
        hdr = ["Driver"] + [f"FY{y}" for y in years] + [mlab[m] for m in meth] + ["Method used", "Used"]
        r0 = 3
        ws.write_row(r0, 0, hdr, self.head())
        ws.write(r0 + 1, 0, "Fiscal year", self.lab(True))
        ycol = {y: 1 + j for j, y in enumerate(years)}
        for y, c in ycol.items():
            ws.write(r0 + 1, c, y, self.F(num_format="0", bold=True, align="right"))
        mcol = {m: 1 + len(years) + j for j, m in enumerate(meth)}
        c_used_m, c_used = 1 + len(years) + len(meth), 2 + len(years) + len(meth)
        self.drv_used = {}
        lo_hi = {"growth": (-0.3, 0.6), "margin": (-0.3, 0.7), "taxEff": (0, 0.45), "s2c": (0.2, 12), "daPct": (0, 0.4), "capexPct": (0, 0.6), "nwcPct": (-0.3, 0.5)}
        for i, d in enumerate(drivers):
            r, key = r0 + 2 + i, d["key"]
            nf = self.PCT if d.get("unit") == "%" else self.MULT
            lo, hi = lo_hi.get(key, (-1e9, 1e9))
            clamp = lambda e: f"MAX({lo},MIN({hi},{e}))"
            ws.write(r, 0, d["label"], self.lab())
            present = []
            for h in d.get("hist") or []:
                y, c = h["year"], ycol[h["year"]]
                fx = self._hist_formula(key, y)
                v = _f(h.get("v"))
                if fx:
                    ws.write_formula(r, c, fx, self.link(nf), v)
                else:
                    ws.write(r, c, v, self.F(num_format=nf))
                present.append((y, c))
            cand = d.get("cand") or {}
            cells = [_cell(r, c) for _, c in present]
            contiguous = len(present) > 0 and all(present[k + 1][1] == present[k][1] + 1 for k in range(len(present) - 1))
            rng = f"{cells[0]}:{cells[-1]}" if contiguous and cells else ",".join(cells)
            yrs = f"{_cell(r0 + 1, present[0][1], True)}:{_cell(r0 + 1, present[-1][1], True)}" if contiguous and cells else None
            fm = {}
            if cells and key != "nwcPct":
                fm["avg"] = clamp(f"AVERAGE({rng})")
                fm["median"] = clamp(f"MEDIAN({rng})")
                fm["latest"] = clamp(cells[-1])
                fm["wavg"] = clamp("(" + "+".join(f"{c}*{k + 1}" for k, c in enumerate(cells)) + f")/{sum(range(1, len(cells) + 1))}")
                if len(cells) >= 3 and yrs and key != "growth":
                    fm["trend"] = clamp(f"FORECAST({_cell(r0 + 1, present[-1][1])}+{3 if key == 'margin' else 1},{rng},{yrs})")
            if key == "nwcPct" and present:
                num = "+".join(f"{self.H(y, 'dWC')}" for y, _ in present if self.H(y, "dWC"))
                den = "+".join(f"({self.H(y, 'revenue')}-{self.H(self._prev(y), 'revenue')})" for y, _ in present if self._prev(y) is not None)
                if num and den:
                    fm["avg"] = clamp(f"-({num})/({den})")
            if key == "growth":
                win = self._window()
                if len(win) >= 2:
                    f0, f1 = win[0], win[-1]
                    fm["cagr"] = clamp(f"({self.H(f1, 'revenue')}/{self.H(f0, 'revenue')})^(1/({self.H(f1, 'year')}-{self.H(f0, 'year')}))-1")
                if len(win) >= 3:
                    revs = f"{self.H(win[0], 'revenue')}:{_cell(self.hrow[win[-1]], self.hcol['revenue'])}"
                    yrsH = f"{self.H(win[0], 'year')}:{_cell(self.hrow[win[-1]], self.hcol['year'])}"
                    fm["trend"] = clamp(f"FORECAST({self.H(win[-1], 'year')}+1,{revs},{yrsH})/{self.H(win[-1], 'revenue')}-1")
            ind = self._industry_formula(key)
            if ind and cand.get("industry") is not None:
                fm["industry"] = clamp(ind)
            for m in meth:
                c = mcol[m]
                v = _f(cand.get(m))
                if v is None:
                    ws.write(r, c, "", self.F())
                elif m in fm:
                    ws.write_formula(r, c, "=" + fm[m], self.calc(nf), v)
                else:
                    ws.write(r, c, v, self.F(num_format=nf))
            m = d.get("method") or "manual"
            ws.write(r, c_used_m, d.get("methodLabel") or m, self.lab())
            val = _f(d.get("value"))
            if m == "manual" or m not in mcol:
                ws.write(r, c_used, val, self.inp(nf))
            else:
                ws.write_formula(r, c_used, f"={_cell(r, mcol[m])}", self.calc(nf, bold=True), val)
            self.drv_used[key] = (r, c_used)
        ws.set_column(0, 0, 40)
        ws.set_column(1, c_used, 12)
        ws.set_column(c_used_m, c_used_m, 24)
        ws.freeze_panes(r0 + 2, 1)
        ws.write(r0 + 3 + len(drivers), 0, "Recent-weighted gives the latest year the most weight (1, 2, 3 …). Linear trend extrapolates a least-squares line one year ahead (three years for the margin; for growth, the fitted revenue).", self.sub())

    def _window(self):
        look = int(_f(self.A.get("look"), 5) or 5)
        ys = [y["year"] for y in self.hist]
        return ys[-min(look, len(ys)):]

    def _prev(self, y):
        ys = [h["year"] for h in self.hist]
        i = ys.index(y) if y in ys else -1
        return ys[i - 1] if i > 0 else None

    def _hist_formula(self, key, y):
        H, p = self.H, self._prev(y)
        if H(y, "revenue") is None:
            return None
        if key == "growth" and p is not None:
            return f"={H(y, 'revenue')}/{H(p, 'revenue')}-1"
        if key == "margin":
            return f"={H(y, 'ebit')}/{H(y, 'revenue')}"
        if key == "taxEff":
            return f"={H(y, 'taxRate')}"
        if key == "s2c":
            return f"={H(y, 'revenue')}/{H(y, 'ic')}"
        if key == "daPct":
            return f"={H(y, 'da')}/{H(y, 'revenue')}"
        if key == "capexPct":
            return f"=ABS({H(y, 'capex')})/{H(y, 'revenue')}"
        if key == "nwcPct" and p is not None:
            return f"=-{H(y, 'dWC')}/({H(y, 'revenue')}-{H(p, 'revenue')})"
        return None

    def _industry_formula(self, key):
        D = self.D
        if key == "growth":
            return D("revGrowthExp") if self._dv("revGrowthExp") is not None else D("revGrowthHist")
        if key == "margin":
            return D("opMargin")
        if key == "taxEff":
            return D("taxEffective")
        if key == "s2c":
            return D("salesToCapital")
        if key == "nwcPct":
            return D("nwcSales")
        if key == "daPct" and D("ebitdaMargin") and D("opMargin"):
            return f"MAX(0,{D('ebitdaMargin')}-{D('opMargin')})"
        if key == "capexPct" and D("netCapexSales") and D("ebitdaMargin") and D("opMargin"):
            return f"{D('netCapexSales')}+MAX(0,{D('ebitdaMargin')}-{D('opMargin')})"
        return None

    def _dv(self, k):
        return _f(((self.p.get("damodaran") or {}).get("industry") or {}).get(k))

    # ------------------------------------------------------------------ Inputs
    def sheet_inputs(self):
        ws, A, p, M = self.ws["Inputs"], self.A, self.p, 1e6
        meta, coc = p["meta"], p.get("coc") or {}
        ws.write(0, 0, f"{meta.get('name')} ({meta.get('sym')}) — model inputs", self.title())
        ws.write(1, 0, "Blue cells are inputs: change them and every sheet recalculates. Green cells link to other sheets; black cells are formulas.", self.sub())
        ws.write_row(3, 0, ["Input", "Value", "Source / note"], self.head())
        r = [4]

        def sec(t):
            r[0] += 1
            ws.write(r[0], 0, t, self.sect())
            r[0] += 1

        def put(label, nm, value, nf, note="", kind="inp", formula=None):
            fmt = self.inp(nf) if kind == "inp" else self.link(nf) if kind == "link" else self.calc(nf)
            ws.write(r[0], 0, label, self.lab(indent=1))
            if formula:
                ws.write_formula(r[0], 1, formula, fmt, value if value is not None else "")
            else:
                ws.write(r[0], 1, value if value is not None else "", fmt)
            if note:
                ws.write_string(r[0], 2, note, self.F(font_color="#6B7280"))
            if nm:
                self.name(nm, "Inputs", r[0], 1)
            r[0] += 1

        sec("Company")
        put("Company", None, meta.get("name"), "@", meta.get("sector") or "", "calc")
        put("Ticker", None, meta.get("sym"), "@", meta.get("currency") or "", "calc")
        put("Share price", "SharePrice", _f(A.get("price")), self.PRICE, "Yahoo Finance, delayed")
        put("Diluted shares (m)", "Shares", _f(A.get("shares"), 0) / M, "#,##0.0", "latest filing")
        put("Total debt ($m)", "Debt", max(_f(A.get("debt"), 0), 0) / M, self.MONEY, "latest balance sheet")
        put("Net debt ($m)", "NetDebt", _f(A.get("netDebt"), 0) / M, self.MONEY, "debt − cash")
        put("Minority interest ($m)", "Minority", _f(A.get("minority"), 0) / M, self.MONEY)
        put("Non-operating assets ($m)", "NonOperating", _f(A.get("investments"), 0) / M, self.MONEY)
        put("Market capitalisation ($m)", "MarketCap", (_f(A.get("price"), 0) * _f(A.get("shares"), 0)) / M, self.MONEY, "price × shares", "calc", "=SharePrice*Shares")
        sec(f"Base year (FY{A.get('baseYear')})")
        put("Base fiscal year", "BaseYear", int(A.get("baseYear") or 0), "0", "", "calc")
        by = int(A.get("baseYear") or 0)
        put("Revenue ($m)", "Revenue0", _f(A.get("revenue0"), 0) / M, self.MONEY, "Historicals", "link", f"={self.H(by, 'revenue')}" if self.H(by, "revenue") else None)
        put("EBIT margin", "Margin0", _f(A.get("margin0")), self.PCT, "Historicals", "link", f"={self.H(by, 'ebit')}/{self.H(by, 'revenue')}" if self.H(by, "ebit") else None)
        L = self.hist[-1] if self.hist else {}
        put("EBIT ($m)", "EBIT0", _f(L.get("ebit"), 0) / M, self.MONEY, "Historicals", "link", f"={self.H(by, 'ebit')}" if self.H(by, "ebit") else None)
        put("Interest expense ($m)", "Interest0", _f(L.get("interest"), 0) / M, self.MONEY, "Historicals", "link", f"={self.H(by, 'interest')}" if self.H(by, "interest") else None)
        ic_note = "book equity + debt − cash" if self.H(by, "ic") and _f(L.get("equityBook")) is not None else "estimated: revenue ÷ sales-to-capital"
        put("Invested capital ($m)", "InvestedCapital0", _f(A.get("ic0"), 0) / M, self.MONEY, ic_note, "link" if "book" in ic_note else "inp",
            f"={self.H(by, 'ic')}" if "book" in ic_note else None)
        sec("Operating drivers (from the Drivers sheet)")
        for key, nm, lab, nf in (("growth", "GrowthHigh", "Revenue growth, high-growth years", self.PCT2), ("margin", "MarginTarget", "Target EBIT margin", self.PCT2),
                                 ("taxEff", "TaxEffective", "Effective tax rate (early years)", self.PCT2), ("s2c", "SalesToCapital", "Sales-to-capital ratio", self.NUM2),
                                 ("daPct", "DAPct", "D&A, % of revenue", self.PCT2), ("capexPct", "CapexPct", "Capex, % of revenue", self.PCT2), ("nwcPct", "NWCPct", "Working capital, % of revenue change", self.PCT2)):
            rc = self.drv_used.get(key)
            field = {"growth": "g1", "margin": "marginTarget"}.get(key, key)
            v = _f(A.get(field))
            if rc:
                put(lab, nm, v, nf, "Drivers sheet", "link", f"={self.ref('Drivers', *rc)}")
            else:
                put(lab, nm, v, nf)
        sec("Model structure")
        put("Forecast years", "YearsN", self.N, "0", "fixed by the model's columns (change it in Agula)", "calc")
        put("High-growth years", "YearsHigh", int(A.get("hgYears") or 5), "0", "then growth, tax and cost of capital fade to stable")
        put("Margin reaches target in year", "MarginYear", int(A.get("convYear") or 5), "0")
        put("Reinvestment method (1 sales-to-capital, 2 capex − D&A + working capital)", "ReinvMethod", 2 if A.get("reinvMethod") == "items" else 1, "0")
        put("Terminal value method (1 stable growth, 2 exit multiple, 3 average)", "TVMethod", {"exit": 2, "blend": 3}.get(A.get("tvMethod"), 1), "0")
        put("Mid-year discounting (1 yes, 0 no)", "MidYear", 1 if A.get("midYear") else 0, "0")
        put("Exit EV/EBITDA", "ExitMultiple", _f(A.get("exitMultiple")), self.MULT, "median of comparable companies")
        self._tg_row = r[0]
        r[0] += 1                                           # terminal growth (formula needs the stable WACC)
        self._roic_row = r[0]
        r[0] += 1
        sec("Cost of capital inputs")
        dam = bool(self.p.get("damodaran"))
        put("Risk-free rate (10-year Treasury)", "RiskFree", _f(A.get("rf")), self.PCT2, "US Treasury / FRED")
        put("Implied equity risk premium", "ERPImplied", _f(A.get("erp")), self.PCT2, (A.get("src") or {}).get("erp", ""))
        put("Country risk adjustment", "CountryRisk", _f(A.get("crp")), self.PCT2, (A.get("src") or {}).get("crp", ""))
        put("Unlevered beta (cash-corrected)", "BetaUnlevered", _f(A.get("betaU")), self.NUM2, (A.get("src") or {}).get("betaU", ""),
            "link" if dam and self.D("betaUCash") and A.get("betaMethod") == "bottomup" else "inp", f"={self.D('betaUCash')}" if dam and self.D("betaUCash") and abs((_f(A.get("betaU"), 0) or 0) - (self._dv("betaUCash") or -9)) < 1e-9 else None)
        de_formula = "=Debt/MarketCap" if A.get("deMethod") == "company" else (f"={self.D('de')}" if A.get("deMethod") == "industry" and self.D("de") else None)
        put("Debt / equity (market)", "DERatio", _f(A.get("de")), self.PCT2, {"company": "company: debt ÷ market cap", "industry": "Damodaran industry"}.get(A.get("deMethod"), "manual"), "calc" if de_formula else "inp", de_formula)
        put("Marginal tax rate", "TaxMarginal", _f(A.get("taxMarg")), self.PCT2, (A.get("src") or {}).get("taxMarg", ""))
        put("Beta method (1 bottom-up, 2 regression, 3 industry levered, 4 manual)", "BetaMethod", {"regression": 2, "industry": 3, "manual": 4}.get(A.get("betaMethod"), 1), "0")
        put("Regression beta (Yahoo)", "BetaRegression", _f(A.get("betaRegression")), self.NUM2)
        put("Industry levered beta", "BetaIndustry", _f(A.get("betaIndustry")), self.NUM2, "Damodaran")
        put("Manual beta", "BetaManual", _f(A.get("betaManual")), self.NUM2)
        put("Interest coverage (EBIT ÷ interest)", "Coverage", _f(A.get("coverage")), "0.00", "", "calc", "=IF(Interest0>0,EBIT0/Interest0,100)")
        put("Cost of debt method (1 synthetic rating, 2 interest ÷ debt, 3 manual)", "KdMethod", {"actual": 2, "manual": 3}.get(A.get("kdMethod"), 1), "0")
        spread_formula = None
        if self.rating_rng and A.get("rating") != "manual spread":
            a, b = self.rating_rng
            spread_formula = f"=LOOKUP(Coverage,Damodaran!$A${a + 1}:$A${b + 1},Damodaran!$D${a + 1}:$D${b + 1})"
        put("Company default spread (synthetic rating)", "SpreadCompany", _f(A.get("kdSpread")), self.PCT2, f"rating {A.get('rating') or '—'}", "calc" if spread_formula else "inp", spread_formula)
        if self.rating_rng:
            a, b = self.rating_rng
            put("Synthetic rating", "Rating", A.get("rating") or "", "@", "Damodaran interest-coverage table", "calc", f"=LOOKUP(Coverage,Damodaran!$A${a + 1}:$A${b + 1},Damodaran!$C${a + 1}:$C${b + 1})" if A.get("rating") != "manual spread" else None)
        put("Country default spread", "SpreadCountry", _f(A.get("ctrySpread"), 0), self.PCT2, "Damodaran country table (0 for US companies)")
        kd_act = _f(A.get("kdActual"))
        put("Interest ÷ debt (actual)", "KdActual", kd_act, self.PCT2, "", "calc", "=IF(AND(Debt>0,Interest0>0),MAX(0.01,MIN(0.2,Interest0/Debt)),\"\")")
        put("Manual pre-tax cost of debt", "KdManual", _f(A.get("kdManual")), self.PCT2)
        put("Stable beta", "BetaStable", _f(A.get("stableBeta"), 1), self.NUM2, "mature firms move towards 1")
        put("Stable debt / capital", "DebtRatioStable", _f(A.get("stableWd")), self.PCT2, "Damodaran industry D/(D+E)")
        put("WACC override (blank = build-up)", "WACCOverride", _f(A.get("waccOverride")), self.PCT2)
        put("Stable WACC override (blank = build-up)", "WACCStableOverride", _f(A.get("stableWaccOverride")), self.PCT2)
        put("WACC shift for sensitivity (normally 0)", "WACCShift", _f(A.get("waccShift"), 0), self.PCT2)
        ws.set_column(0, 0, 66)
        ws.set_column(1, 1, 16)
        ws.set_column(2, 2, 60)
        ws.freeze_panes(4, 0)

    def finish_inputs(self):
        """Terminal growth and stable ROIC depend on the stable WACC, so they are written after the Cost of capital sheet."""
        ws, A = self.ws["Inputs"], self.A
        tg, rm = A.get("tgMethod"), A.get("roicMethod")
        tg_f = {"lower": "=MIN(RiskFree,WACCStable-0.01,MAX(GrowthHigh,0.02))", "rf": "=MIN(RiskFree,WACCStable-0.01)", "inflation": "=0.025"}.get(tg)
        tg_note = {"lower": "lower of risk-free rate and high growth (min 2%)", "rf": "risk-free rate (Damodaran)", "inflation": "long-run nominal GDP"}.get(tg, "manual")
        ws.write(self._tg_row, 0, "Terminal (stable) growth", self.lab(indent=1))
        if tg_f:
            ws.write_formula(self._tg_row, 1, tg_f, self.calc(self.PCT2), _f(A.get("termGrowth")))
        else:
            ws.write(self._tg_row, 1, _f(A.get("termGrowth")), self.inp(self.PCT2))
        ws.write_string(self._tg_row, 2, tg_note, self.F(font_color="#6B7280"))
        self.name("GrowthTerminal", "Inputs", self._tg_row, 1)
        ws.write(self._roic_row, 0, "Return on capital in stable growth", self.lab(indent=1))
        roc = self.D("roc")
        roic_f = {"industry": f"=MAX({roc},WACCStable)" if roc else None, "wacc": "=WACCStable"}.get(rm)
        if roic_f:
            ws.write_formula(self._roic_row, 1, roic_f, self.calc(self.PCT2), _f(A.get("roicStable")))
        else:
            ws.write(self._roic_row, 1, _f(A.get("roicStable")), self.inp(self.PCT2))
        ws.write_string(self._roic_row, 2, {"industry": "Damodaran industry ROC (at least the stable WACC)", "wacc": "equal to the stable cost of capital (no excess returns)"}.get(rm, "company / manual"), self.F(font_color="#6B7280"))
        self.name("ROICStable", "Inputs", self._roic_row, 1)

    # ------------------------------------------------------------------ Cost of capital
    def sheet_coc(self):
        ws, c = self.ws["Cost of capital"], self.p.get("coc") or {}
        ws.write(0, 0, "Cost of capital — Damodaran bottom-up build", self.title())
        ws.write(1, 0, "Beta: industry unlevered beta (corrected for cash) relevered at the company's market D/E: βL = βU × (1 + (1 − t) × D/E). Cost of debt: risk-free + default spread from the synthetic rating + country spread.", self.sub())
        ws.write_row(3, 0, ["Item", "Value", "Formula"], self.head())
        rows = [
            ("Levered beta, bottom-up", "BetaBottomUp", "=BetaUnlevered*(1+(1-TaxMarginal)*DERatio)", c.get("betaL"), self.NUM2, "βU × (1 + (1 − t) × D/E)"),
            ("Beta used", "BetaUsed", "=CHOOSE(BetaMethod,BetaBottomUp,BetaRegression,BetaIndustry,BetaManual)", c.get("beta"), self.NUM2, "per Beta method on Inputs"),
            ("Total equity risk premium", "ERPTotal", "=ERPImplied+CountryRisk", c.get("erpT"), self.PCT2, "implied ERP + country risk"),
            ("Cost of equity", "CostEquity", "=RiskFree+BetaUsed*ERPTotal", c.get("ke"), self.PCT2, "risk-free + β × ERP"),
            ("Pre-tax cost of debt", "KdPre", "=CHOOSE(KdMethod,RiskFree+SpreadCompany+SpreadCountry,IF(ISNUMBER(KdActual),KdActual,RiskFree+SpreadCompany+SpreadCountry),KdManual)", c.get("kdPre"), self.PCT2, "risk-free + spreads"),
            ("After-tax cost of debt", "KdAfter", "=KdPre*(1-TaxMarginal)", c.get("kdAfter"), self.PCT2, "× (1 − marginal tax)"),
            ("Debt / capital", "WeightDebt", "=DERatio/(1+DERatio)", c.get("wd"), self.PCT2, "D/E ÷ (1 + D/E)"),
            ("Equity / capital", "WeightEquity", "=1-WeightDebt", c.get("we"), self.PCT2, ""),
            ("WACC, build-up", "WACCBuild", "=WeightEquity*CostEquity+WeightDebt*KdAfter", c.get("wacc"), self.PCT2, "E/V × ke + D/V × kd(1 − t)"),
            ("WACC, high-growth years", "WACCHigh", "=IF(ISNUMBER(WACCOverride),WACCOverride,WACCBuild)+WACCShift", c.get("W0"), self.PCT2, "override if given"),
            ("Stable cost of equity", "CostEquityStable", "=RiskFree+BetaStable*ERPTotal", c.get("keS"), self.PCT2, "stable beta"),
            ("Stable debt / capital", "WeightDebtStable", "=MAX(0,MIN(0.9,DebtRatioStable))", c.get("wdS"), self.PCT2, ""),
            ("Stable WACC, build-up", "WACCStableBuild", "=(1-WeightDebtStable)*CostEquityStable+WeightDebtStable*KdAfter", c.get("waccStable"), self.PCT2, ""),
            ("WACC, stable growth", "WACCStable", "=IF(ISNUMBER(WACCStableOverride),WACCStableOverride,WACCStableBuild)+WACCShift", c.get("WS"), self.PCT2, "override if given"),
        ]
        for i, (lab, nm, fx, v, nf, note) in enumerate(rows):
            r = 4 + i
            bold = nm in ("CostEquity", "WACCHigh", "WACCStable")
            ws.write(r, 0, lab, self.lab(bold))
            ws.write_formula(r, 1, fx, self.key(nf) if bold else self.calc(nf), _f(v))
            ws.write_string(r, 2, note, self.F(font_color="#6B7280"))
            self.name(nm, "Cost of capital", r, 1)
        r = 4 + len(rows) + 1
        d = (self.p.get("damodaran") or {})
        if d.get("industry"):
            ws.write(r, 0, "For comparison (Damodaran)", self.sect())
            ws.write(r + 1, 0, f"{d.get('industryName')} cost of capital", self.lab())
            ws.write_formula(r + 1, 1, f"={self.D('wacc')}" if self.D("wacc") else "=0", self.link(self.PCT2), _f(d["industry"].get("wacc")))
            ws.write(r + 2, 0, "US market cost of capital", self.lab())
            ws.write(r + 2, 1, _f((d.get("market") or {}).get("wacc")), self.F(num_format=self.PCT2))
        self.coc_chart_rows = (4, 4 + len(rows) - 1)
        ws.set_column(0, 0, 34)
        ws.set_column(1, 1, 14)
        ws.set_column(2, 2, 40)
        self.finish_inputs()

    # ------------------------------------------------------------------ DCF (formula-driven)
    def sheet_dcf(self):
        ws, A, p, M, N = self.ws["DCF"], self.A, self.p, 1e6, self.N
        t = p.get("terminal") or {}
        meta = p["meta"]
        ws.write(0, 0, f"{meta.get('name')} ({meta.get('sym')}) — free cash flow to the firm, $ millions", self.title())
        ws.write(1, 0, "Growth and margin rows follow the Inputs (fade rules) unless edited year by year in Agula, in which case they are blue inputs here. Last column = first stable-growth year.", self.sub())
        labels = ["Fiscal year", "Year", "Revenue growth", "Revenue", "EBIT margin", "EBIT", "Tax rate", "Taxes on EBIT", "NOPAT", "D&A", "Capex", "Increase in working capital",
                  "Reinvestment", "Free cash flow to the firm", "EBITDA", "Cost of capital", "Cumulative discount factor", "Discount factor used", "Present value of FCFF",
                  "Invested capital (start of year)", "Return on invested capital"]
        R = {k: 3 + i for i, k in enumerate(["fy", "t", "g", "rev", "m", "ebit", "tax", "taxes", "nopat", "da", "capex", "dnwc", "reinv", "fcff", "ebitda", "wacc", "cum", "df", "pv", "ic", "roic"])}
        self.R = R
        hdr = ["$ millions", f"FY{A.get('baseYear')}A"] + [f"FY{x['year']}E" for x in self.rows] + ["Stable"]
        ws.write_row(2, 0, hdr, self.head())
        for k, r in R.items():
            ws.write(r, 0, labels[r - 3], self.lab(k in ("rev", "fcff", "pv")))
        B, last, S = 1, 1 + N, 2 + N
        self.dcol = (2, last, S)
        col = lambda c: _cell(0, c).rstrip("0123456789")
        # base column
        ws.write_formula(R["fy"], B, "=BaseYear", self.calc("0"), A.get("baseYear"))
        ws.write(R["t"], B, 0, self.calc("0"))
        ws.write_formula(R["rev"], B, "=Revenue0", self.link(self.MONEY), _f(A.get("revenue0"), 0) / M)
        ws.write_formula(R["m"], B, "=Margin0", self.link(self.PCT), _f(A.get("margin0")))
        ws.write_formula(R["ebit"], B, f"={col(B)}{R['rev'] + 1}*{col(B)}{R['m'] + 1}", self.calc(self.MONEY), _f(A.get("revenue0"), 0) * _f(A.get("margin0"), 0) / M)
        ws.write(R["cum"], B, 1, self.calc("0.0000"))
        gp, mp = A.get("growthPath"), A.get("marginPath")
        for i, x in enumerate(self.rows):
            c, pc = 2 + i, 1 + i
            C, P = col(c), col(pc)
            a = lambda k: f"{C}{R[k] + 1}"
            pr = lambda k: f"{P}{R[k] + 1}"
            ws.write_formula(R["fy"], c, f"={pr('fy')}+1", self.calc("0"), x["year"])
            ws.write_formula(R["t"], c, f"={a('fy')}-$B${R['fy'] + 1}", self.calc("0"), i + 1)
            if gp:
                ws.write(R["g"], c, _f(x.get("growth")), self.inp(self.PCT))
            else:
                ws.write_formula(R["g"], c, f"=IF({a('t')}<=YearsHigh,GrowthHigh,GrowthHigh+(GrowthTerminal-GrowthHigh)*({a('t')}-YearsHigh)/(YearsN-YearsHigh))", self.calc(self.PCT), _f(x.get("growth")))
            ws.write_formula(R["rev"], c, f"={pr('rev')}*(1+{a('g')})", self.calc(self.MONEY, bold=True), _f(x["rev"], 0) / M)
            if mp:
                ws.write(R["m"], c, _f(x.get("margin")), self.inp(self.PCT))
            else:
                ws.write_formula(R["m"], c, f"=IF({a('t')}>=MarginYear,MarginTarget,Margin0+(MarginTarget-Margin0)*{a('t')}/MarginYear)", self.calc(self.PCT), _f(x.get("margin")))
            ws.write_formula(R["ebit"], c, f"={a('rev')}*{a('m')}", self.calc(self.MONEY), _f(x["ebit"], 0) / M)
            ws.write_formula(R["tax"], c, f"=IF(OR({a('t')}<=YearsHigh,YearsN=YearsHigh),TaxEffective,TaxEffective+(TaxMarginal-TaxEffective)*({a('t')}-YearsHigh)/(YearsN-YearsHigh))", self.calc(self.PCT), _f(x["taxRate"]))
            ws.write_formula(R["taxes"], c, f"=MAX({a('ebit')},0)*{a('tax')}", self.calc(self.MONEY), _f(x["tax"], 0) / M)
            ws.write_formula(R["nopat"], c, f"={a('ebit')}-{a('taxes')}", self.calc(self.MONEY), _f(x["nopat"], 0) / M)
            ws.write_formula(R["da"], c, f"={a('rev')}*DAPct", self.calc(self.MONEY), _f(x["da"], 0) / M)
            ws.write_formula(R["capex"], c, f"={a('rev')}*CapexPct", self.calc(self.MONEY), _f(x["capex"], 0) / M)
            ws.write_formula(R["dnwc"], c, f"=({a('rev')}-{pr('rev')})*NWCPct", self.calc(self.MONEY), _f(x["dnwc"], 0) / M)
            ws.write_formula(R["reinv"], c, f"=IF(ReinvMethod=2,{a('capex')}-{a('da')}+{a('dnwc')},({a('rev')}-{pr('rev')})/SalesToCapital)", self.calc(self.MONEY), _f(x["reinvest"], 0) / M)
            ws.write_formula(R["fcff"], c, f"={a('nopat')}-{a('reinv')}", self.calc(self.MONEY, bold=True, top=True), _f(x["fcff"], 0) / M)
            ws.write_formula(R["ebitda"], c, f"={a('ebit')}+{a('da')}", self.calc(self.MONEY), _f(x["ebitda"], 0) / M)
            ws.write_formula(R["wacc"], c, f"=IF({a('t')}<=YearsHigh,WACCHigh,WACCHigh+(WACCStable-WACCHigh)*({a('t')}-YearsHigh)/(YearsN-YearsHigh))", self.calc(self.PCT2), _f(x["wacc"]))
            ws.write_formula(R["cum"], c, f"={pr('cum')}/(1+{a('wacc')})", self.calc("0.0000"), _f(x["cum"]))
            ws.write_formula(R["df"], c, f"=IF(MidYear=1,{pr('cum')}/SQRT(1+{a('wacc')}),{a('cum')})", self.calc("0.0000"), _f(x["df"]))
            ws.write_formula(R["pv"], c, f"={a('fcff')}*{a('df')}", self.F(num_format=self.MONEY, bold=True, bg_color="#E8F0FB"), _f(x["pv"], 0) / M)
            ws.write_formula(R["ic"], c, "=InvestedCapital0" if i == 0 else f"={pr('ic')}+{pr('reinv')}", self.calc(self.MONEY), _f(x["ic0"], 0) / M)
            ws.write_formula(R["roic"], c, f"=IF({a('ic')}>0,{a('nopat')}/{a('ic')},\"\")", self.calc(self.PCT), _f(x.get("roic")) if _f(x.get("roic")) is not None else "")
        # stable-growth column
        Lc, Sc = col(last), col(S)
        s = lambda k: f"{Sc}{R[k] + 1}"
        l = lambda k: f"{Lc}{R[k] + 1}"
        tm = self.F(num_format=self.MONEY, bg_color="#FFF4E0")
        tp = self.F(num_format=self.PCT2, bg_color="#FFF4E0")
        ws.write_formula(R["g"], S, "=GrowthTerminal", tp, _f(A.get("termGrowth")))
        ws.write_formula(R["rev"], S, f"={l('rev')}*(1+{s('g')})", tm, _f(t.get("revN1"), 0) / M)
        ws.write_formula(R["m"], S, f"={l('m')}", tp, _f(t.get("ebitN1"), 0) / (_f(t.get("revN1"), 1) or 1))
        ws.write_formula(R["ebit"], S, f"={s('rev')}*{s('m')}", tm, _f(t.get("ebitN1"), 0) / M)
        ws.write_formula(R["tax"], S, "=TaxMarginal", tp, _f(A.get("taxMarg")))
        ws.write_formula(R["taxes"], S, f"=MAX({s('ebit')},0)*{s('tax')}", tm, (_f(t.get("ebitN1"), 0) - _f(t.get("nopatN1"), 0)) / M)
        ws.write_formula(R["nopat"], S, f"={s('ebit')}-{s('taxes')}", tm, _f(t.get("nopatN1"), 0) / M)
        ws.write_formula(R["reinv"], S, f"={s('nopat')}*{s('g')}/ROICStable", tm, _f(t.get("nopatN1"), 0) * _f(t.get("reinvRateN1"), 0) / M)
        ws.write_formula(R["fcff"], S, f"={s('nopat')}-{s('reinv')}", self.F(num_format=self.MONEY, bg_color="#FFF4E0", bold=True, top=1), _f(t.get("fcffN1"), 0) / M)
        ws.write_formula(R["wacc"], S, "=WACCStable", tp, _f(p["coc"].get("WS")))
        ws.write_formula(R["roic"], S, "=ROICStable", tp, _f(A.get("roicStable")))
        # valuation
        v0 = R["roic"] + 3
        ws.write(v0 - 1, 0, "Valuation", self.sect())
        first = col(2)
        V = [
            ("Sum of PV of FCFF", "SumPV", f"=SUM({first}{R['pv'] + 1}:{Lc}{R['pv'] + 1})", t.get("sumPV"), self.MONEY, 1e6),
            ("Terminal value — stable growth: FCFF(N+1) ÷ (WACC − g)", "TVGordon", f"=IF({s('wacc')}>{s('g')},{s('fcff')}/({s('wacc')}-{s('g')}),NA())", t.get("tvG"), self.MONEY, 1e6),
            ("Terminal value — exit multiple × EBITDA(N)", "TVExit", f"={l('ebitda')}*ExitMultiple", t.get("tvX"), self.MONEY, 1e6),
            ("PV of terminal value — stable growth", "PVTVGordon", f"=TVGordon*{l('cum')}*IF(MidYear=1,SQRT(1+{s('wacc')}),1)", t.get("pvG"), self.MONEY, 1e6),
            ("PV of terminal value — exit multiple", "PVTVExit", f"=TVExit*{l('cum')}", t.get("pvX"), self.MONEY, 1e6),
            ("PV of terminal value (selected method)", "PVTV", "=CHOOSE(TVMethod,PVTVGordon,PVTVExit,(PVTVGordon+PVTVExit)/2)", t.get("pvTV"), self.MONEY, 1e6),
            ("Enterprise value", "EnterpriseValue", "=SumPV+PVTV", t.get("ev"), self.MONEY, 1e6),
            ("Less: net debt", None, "=-NetDebt", -_f(A.get("netDebt"), 0), self.MONEY, 1e6),
            ("Less: minority interest", None, "=-Minority", -_f(A.get("minority"), 0), self.MONEY, 1e6),
            ("Plus: non-operating assets", None, "=NonOperating", _f(A.get("investments"), 0), self.MONEY, 1e6),
            ("Equity value", "EquityValue", "=EnterpriseValue-NetDebt-Minority+NonOperating", t.get("equity"), self.MONEY, 1e6),
            ("Diluted shares (m)", None, "=Shares", _f(A.get("shares"), 0), "#,##0.0", 1e6),
            ("Value per share", "ValuePerShare", "=EquityValue/Shares", t.get("perShare"), self.PRICE, 1),
            ("Current share price", None, "=SharePrice", A.get("price"), self.PRICE, 1),
            ("Upside / (downside)", "Upside", "=ValuePerShare/SharePrice-1", t.get("upside"), self.PCT, 1),
            ("Terminal value as % of EV", "TVShare", "=PVTV/EnterpriseValue", t.get("tvShare"), self.PCT, 1),
            ("Implied exit EV/EBITDA of the stable-growth value", "ImpliedExit", f"=TVGordon/{l('ebitda')}", t.get("impliedExit"), self.MULT, 1),
            ("EV / next-year EBITDA", "EVtoEBITDA", f"=EnterpriseValue/{col(2)}{R['ebitda'] + 1}", (_f(t.get("ev"), 0) / (_f(self.rows[0]["ebitda"], 1) or 1)) if self.rows else None, self.MULT, 1),
        ]
        for i, (lab, nm, fx, v, nf, sc) in enumerate(V):
            r = v0 + i
            key = nm in ("EnterpriseValue", "EquityValue", "ValuePerShare", "Upside")
            ws.write(r, 0, lab, self.lab(key))
            vv = _f(v)
            ws.write_formula(r, 1, fx, self.key(nf) if key else self.calc(nf), vv / sc if vv is not None and sc != 1 else vv)
            if nm:
                self.name(nm, "DCF", r, 1)
        ws.write(v0 + len(V) + 1, 0, f"Growth implied by the exit multiple: {(_f(t.get('impliedG')) or 0) * 100:.2f}% (computed in Agula).", self.note())
        ws.set_column(0, 0, 48)
        ws.set_column(1, S, 11.5)
        ws.freeze_panes(3, 1)
        self.val_rows = v0

    # ------------------------------------------------------------------ Sensitivity
    def sheet_sensitivity(self):
        ws, p = self.ws["Sensitivity"], self.p
        price = _f(p["meta"].get("price"), 0)
        ws.write(0, 0, "Sensitivity of value per share", self.title())
        ws.write(1, 0, "Values from Agula's model. Colour: red below the current price, green above (centre = price).", self.sub())
        titles = {"wg": "WACC × terminal growth", "wx": "WACC × exit multiple (exit-multiple terminal value)", "gm": "High growth × target EBIT margin", "rg": "Stable ROIC × terminal growth"}
        r = 3
        for s in p.get("sens") or []:
            ws.write(r, 0, titles.get(s["key"], s["key"]), self.sect())
            ws.write(r + 1, 0, f"{s['rl']} ↓  {s['cl']} →", self.head())
            ws.write_row(r + 1, 1, s["cols"], self.head())
            for i, (lab, row) in enumerate(zip(s["rows"], s["grid"])):
                ws.write(r + 2 + i, 0, lab, self.F(bold=True, align="right", bg_color="#F3F4F6"))
                for j, v in enumerate(row):
                    fmt = self.F(num_format=self.PRICE, border=1, border_color="#D1D5DB", bold=(i == 3 and j == 3))
                    ws.write(r + 2 + i, 1 + j, _f(v, ""), fmt)
            n = len(s["rows"])
            ws.conditional_format(r + 2, 1, r + 1 + n, len(s["cols"]), {"type": "3_color_scale", "min_color": "#F8696B", "mid_type": "num", "mid_value": price, "mid_color": "#FFFFFF", "max_color": "#63BE7B"})
            r += n + 4
        ws.set_column(0, 0, 30)
        ws.set_column(1, 8, 12)

    # ------------------------------------------------------------------ Scenarios & Monte Carlo
    def sheet_scenarios(self):
        ws, p = self.ws["Scenarios"], self.p
        sc, mc = p.get("scen") or {}, p.get("mc") or {}
        ws.write(0, 0, "Scenarios, Monte Carlo and reverse DCF", self.title())
        ws.write_row(2, 0, ["Scenario", "High growth", "Target EBIT margin", "WACC (high growth)", "Terminal growth", "Value per share", "Probability", "Weighted"], self.head())
        for i, row in enumerate(sc.get("rows") or []):
            r = 3 + i
            ws.write(r, 0, row["k"].capitalize(), self.lab(True))
            for j, (k, nf) in enumerate((("g1", self.PCT), ("margin", self.PCT), ("wacc", self.PCT2), ("tg", self.PCT2), ("value", self.PRICE))):
                ws.write(r, 1 + j, _f(row.get(k)), self.F(num_format=nf))
            ws.write(r, 6, _f(row.get("prob")), self.inp(self.PCT))
            ws.write_formula(r, 7, f"=F{r + 1}*G{r + 1}", self.calc(self.PRICE), (_f(row.get("value"), 0) * _f(row.get("prob"), 0)))
        ws.write(6, 0, "Probability-weighted value", self.lab(True))
        ws.write_formula(6, 5, "=SUMPRODUCT(F4:F6,G4:G6)/SUM(G4:G6)", self.key(self.PRICE), _f(sc.get("pw")))
        self.name("ScenarioValue", "Scenarios", 6, 5)
        ws.write(8, 0, "Monte Carlo (4,000 runs)", self.sect())
        for i, (lab, k, nf) in enumerate((("10th percentile", "p10", self.PRICE), ("Median", "p50", self.PRICE), ("90th percentile", "p90", self.PRICE), ("Probability value exceeds price", "prob", self.PCT))):
            ws.write(9 + i, 0, lab, self.lab())
            ws.write(9 + i, 1, _f(mc.get(k)), self.F(num_format=nf))
        self.name("MCMedian", "Scenarios", 10, 1)
        ws.write(14, 0, "Reverse DCF: high growth implied by the share price", self.lab(True))
        ws.write(14, 1, _f(p.get("reverse"), "n/a"), self.F(num_format=self.PCT2))
        bins = mc.get("bins") or []
        ws.write(16, 0, "Distribution of value per share", self.sect())
        ws.write_row(17, 0, ["From", "To", "Runs", "Label"], self.head())
        for i, b in enumerate(bins):
            ws.write(18 + i, 0, _f(b["x0"]), self.F(num_format=self.PRICE))
            ws.write(18 + i, 1, _f(b["x1"]), self.F(num_format=self.PRICE))
            ws.write(18 + i, 2, int(b["n"]))
            ws.write(18 + i, 3, f"{_f(b['x0'], 0):,.0f}–{_f(b['x1'], 0):,.0f}")
        self.mc_rows = (18, 17 + len(bins))
        foot = p.get("foot") or []
        r = 20 + len(bins)
        ws.write(r, 0, "Valuation range (football field)", self.sect())
        ws.write_row(r + 1, 0, ["Method", "Low", "High", "Range"], self.head())
        for i, fr in enumerate(foot):
            ws.write(r + 2 + i, 0, fr.get("label") or "", self.lab())
            ws.write(r + 2 + i, 1, _f(fr.get("lo")), self.F(num_format=self.PRICE))
            ws.write(r + 2 + i, 2, _f(fr.get("hi")), self.F(num_format=self.PRICE))
            ws.write_formula(r + 2 + i, 3, f"=C{r + 3 + i}-B{r + 3 + i}", self.calc(self.PRICE), (_f(fr.get("hi"), 0) - _f(fr.get("lo"), 0)))
        self.foot_rows = (r + 2, r + 1 + len(foot))
        ws.set_column(0, 0, 44)
        ws.set_column(1, 7, 15)

    # ------------------------------------------------------------------ Peers & industry
    def sheet_peers(self):
        ws, p = self.ws["Peers & industry"], self.p
        ws.write(0, 0, "Comparable companies and Damodaran benchmarks", self.title())
        bench = p.get("bench") or []
        ws.write(2, 0, "Company vs industry vs US market", self.sect())
        nfu = {"%": self.PCT, "x": self.MULT, "n": self.NUM2}
        if bench:
            ws.add_table(3, 0, 3 + len(bench), 3, {"name": "Benchmarks", "style": "Table Style Medium 9", "autofilter": False,
                                                    "columns": [{"header": "Measure"}, {"header": p["meta"].get("sym") or "Company"}, {"header": (p.get("damodaran") or {}).get("industryName") or "Industry"}, {"header": "US market"}],
                                                    "data": [[b.get("label"), _f(b.get("company")), _f(b.get("industry")), _f(b.get("market"))] for b in bench]})
            for i, b in enumerate(bench):
                for j in (1, 2, 3):
                    v = _f(b.get(["company", "industry", "market"][j - 1]))
                    ws.write(4 + i, j, v if v is not None else "n/a", self.F(num_format=nfu.get(b.get("unit"), self.NUM2)))
        self.bench_rows = (4, 3 + len(bench))
        peers = p.get("peers") or []
        r = 6 + len(bench)
        ws.write(r, 0, "Comparable companies (US large caps, same sector first)", self.sect())
        if peers:
            ws.add_table(r + 1, 0, r + 1 + len(peers), 8, {"name": "Peers", "style": "Table Style Medium 2", "autofilter": True,
                                                            "columns": [{"header": "Ticker"}, {"header": "Company"}, {"header": "Market cap ($bn)", "format": self.F(num_format="#,##0")},
                                                                        {"header": "EV/EBITDA", "format": self.F(num_format=self.MULT)}, {"header": "P/E", "format": self.F(num_format=self.MULT)},
                                                                        {"header": "EV/Sales", "format": self.F(num_format=self.MULT)}, {"header": "Revenue growth", "format": self.F(num_format=self.PCT)},
                                                                        {"header": "Operating margin", "format": self.F(num_format=self.PCT)}, {"header": "FCF yield", "format": self.F(num_format=self.PCT)}],
                                                            "data": [[x.get("sym"), x.get("name"), (_f(x.get("cap"), 0) or 0) / 1e9, _f(x.get("evEbitda")), _f(x.get("pe")), _f(x.get("evSales")), _f(x.get("growth")), _f(x.get("margin")), _f(x.get("fcfy"))] for x in peers]})
            ws.write(r + 2 + len(peers), 0, "Median (excluding the company)", self.lab(True))
            for j in range(3, 9):
                vals = [v for v in [_f([None, None, None, x.get("evEbitda"), x.get("pe"), x.get("evSales"), x.get("growth"), x.get("margin"), x.get("fcfy")][j]) for x in peers if not x.get("self")] if v is not None]
                ws.write(r + 2 + len(peers), j, float(np.median(vals)) if vals else "", self.F(bold=True, num_format=self.MULT if j < 6 else self.PCT))
        ws.set_column(0, 0, 44)
        ws.set_column(1, 1, 30)
        ws.set_column(2, 8, 14)

    # ------------------------------------------------------------------ Chart data (live links)
    def sheet_chartdata(self):
        ws, M = self.ws["Chart data"], 1e6
        ws.write(0, 0, "Series behind the charts on the Summary sheet (formulas linking to the model)", self.title())
        ws.write_row(2, 0, ["Year", "Revenue, actual", "Revenue, forecast", "Free cash flow", "Growth, actual", "Growth, forecast", "EBIT margin", "ROIC", "Cost of capital", "Cumulative PV of FCFF", "Enterprise value"], self.head())
        R, (c0, last, S) = self.R, self.dcol
        col = lambda c: _cell(0, c).rstrip("0123456789")
        r = 3
        for i, y in enumerate(self.hist):
            yr = y["year"]
            ws.write_formula(r, 0, f"={self.H(yr, 'year')}", self.calc("0"), yr)
            ws.write_formula(r, 1, f"={self.H(yr, 'revenue')}", self.calc(self.MONEY), _f(y["revenue"], 0) / M)
            fcf = _f(y.get("fcf"))
            if fcf is not None:
                ws.write_formula(r, 3, f"={self.H(yr, 'fcf')}", self.calc(self.MONEY), fcf / M)
            if i:
                ws.write_formula(r, 4, f"={self.H(yr, 'growth')}", self.calc(self.PCT), _f(y["revenue"]) / _f(self.hist[i - 1]["revenue"]) - 1)
            if _f(y.get("ebit")) is not None:
                ws.write_formula(r, 6, f"={self.H(yr, 'margin')}", self.calc(self.PCT), _f(y["ebit"]) / _f(y["revenue"]))
            r += 1
        self.cd_hist = (3, r - 1)
        cum = 0.0
        for i, x in enumerate(self.rows):
            c = col(2 + i)
            g = lambda k: f"=DCF!{c}{R[k] + 1}"
            ws.write_formula(r, 0, g("fy"), self.calc("0"), x["year"])
            ws.write_formula(r, 2, g("rev"), self.calc(self.MONEY), _f(x["rev"], 0) / M)
            ws.write_formula(r, 3, g("fcff"), self.calc(self.MONEY), _f(x["fcff"], 0) / M)
            ws.write_formula(r, 5, g("g"), self.calc(self.PCT), _f(x.get("growth")))
            ws.write_formula(r, 6, g("m"), self.calc(self.PCT), _f(x.get("margin")))
            if _f(x.get("roic")) is not None:
                ws.write_formula(r, 7, g("roic"), self.calc(self.PCT), _f(x["roic"]))
            ws.write_formula(r, 8, g("wacc"), self.calc(self.PCT2), _f(x["wacc"]))
            cum += _f(x["pv"], 0) / M
            ws.write_formula(r, 9, f"=SUM(DCF!{col(2)}{R['pv'] + 1}:{c}{R['pv'] + 1})", self.calc(self.MONEY), cum)
            ws.write_formula(r, 10, "=EnterpriseValue", self.calc(self.MONEY), _f((self.p.get("terminal") or {}).get("ev"), 0) / M)
            r += 1
        self.cd_fc = (self.cd_hist[1] + 1, r - 1)
        self.cd_all = (3, r - 1)
        # bridge (waterfall as a stacked column with an invisible base)
        t, A = self.p.get("terminal") or {}, self.A
        r += 1
        ws.write_row(r, 0, ["Bridge step", "Base (hidden)", "Up", "Down", "Total"], self.head())
        steps = [("PV of FCFF", "=SumPV", "total"), ("PV of terminal value", "=PVTV", "up"), ("Enterprise value", "=EnterpriseValue", "total"), ("Net debt", "=-NetDebt", "move"),
                 ("Minority interest", "=-Minority", "move"), ("Non-operating assets", "=NonOperating", "move"), ("Equity value", "=EquityValue", "total")]
        vals = {"=SumPV": _f(t.get("sumPV"), 0) / M, "=PVTV": _f(t.get("pvTV"), 0) / M, "=EnterpriseValue": _f(t.get("ev"), 0) / M, "=-NetDebt": -_f(A.get("netDebt"), 0) / M,
                "=-Minority": -_f(A.get("minority"), 0) / M, "=NonOperating": _f(A.get("investments"), 0) / M, "=EquityValue": _f(t.get("equity"), 0) / M}
        run = 0.0
        b0 = r + 1
        for i, (lab, fx, kind) in enumerate(steps):
            rr = b0 + i
            v = vals[fx]
            ws.write(rr, 0, lab)
            ws.write_formula(rr, 5, fx, self.calc(self.MONEY), v)              # step value (column F)
            F = f"F{rr + 1}"
            if kind == "total":
                ws.write(rr, 1, 0, self.calc(self.MONEY))
                ws.write(rr, 2, 0, self.calc(self.MONEY))
                ws.write(rr, 3, 0, self.calc(self.MONEY))
                ws.write_formula(rr, 4, f"={F}", self.calc(self.MONEY), v)
                run = v
            else:
                prev_run = f"G{rr}"
                ws.write_formula(rr, 1, f"=IF({F}>=0,{prev_run},{prev_run}+{F})", self.calc(self.MONEY), run if v >= 0 else run + v)
                ws.write_formula(rr, 2, f"=MAX({F},0)", self.calc(self.MONEY), max(v, 0))
                ws.write_formula(rr, 3, f"=MAX(-{F},0)", self.calc(self.MONEY), max(-v, 0))
                ws.write(rr, 4, 0, self.calc(self.MONEY))
                run += v
            ws.write_formula(rr, 6, f"={F}" if kind == "total" else f"=G{rr}+{F}", self.calc(self.MONEY), run)   # running total (column G)
        ws.write(b0 - 1, 5, "Step", self.head())
        ws.write(b0 - 1, 6, "Running total", self.head())
        self.cd_bridge = (b0, b0 + len(steps) - 1)
        # cost of capital build-up (percent series only)
        c = self.p.get("coc") or {}
        r = b0 + len(steps) + 1
        ws.write_row(r, 0, ["Cost of capital item", "Rate"], self.head())
        items = [("Risk-free rate", "=RiskFree", A.get("rf")), ("Beta × ERP", "=BetaUsed*ERPImplied", (_f(c.get("beta"), 0) * _f(A.get("erp"), 0))),
                 ("Beta × country risk", "=BetaUsed*CountryRisk", (_f(c.get("beta"), 0) * _f(A.get("crp"), 0))), ("Cost of equity", "=CostEquity", c.get("ke")),
                 ("Pre-tax cost of debt", "=KdPre", c.get("kdPre")), ("After-tax cost of debt", "=KdAfter", c.get("kdAfter")),
                 ("WACC, high growth", "=WACCHigh", c.get("W0")), ("WACC, stable", "=WACCStable", c.get("WS"))]
        dw = _f(((self.p.get("damodaran") or {}).get("industry") or {}).get("wacc"))
        if dw is not None and self.D("wacc"):
            items.append(("Industry WACC (Damodaran)", f"={self.D('wacc')}", dw))
        for i, (lab, fx, v) in enumerate(items):
            ws.write(r + 1 + i, 0, lab)
            ws.write_formula(r + 1 + i, 1, fx, self.calc(self.PCT2), _f(v))
        self.cd_coc = (r + 1, r + len(items))
        # company vs industry (percentage measures only, linked to the Peers & industry sheet)
        bench = self.p.get("bench") or []
        pct_rows = [(i, b) for i, b in enumerate(bench) if b.get("unit") == "%"]
        r = r + len(items) + 2
        ws.write_row(r, 0, ["Measure (%)", self.p["meta"].get("sym") or "Company", "Industry", "US market"], self.head())
        for k, (i, b) in enumerate(pct_rows):
            ws.write(r + 1 + k, 0, b.get("label"))
            for j, key in enumerate(("company", "industry", "market")):
                v = _f(b.get(key))
                if v is not None:
                    ws.write_formula(r + 1 + k, 1 + j, f"={_q('Peers & industry')}!{_cell(4 + i, 1 + j)}", self.calc(self.PCT), v)
        self.cd_bench = (r + 1, r + len(pct_rows))
        ws.set_column(0, 0, 22)
        ws.set_column(1, 10, 15)

    # ------------------------------------------------------------------ Summary with charts
    def chart(self, kind, **k):
        ch = self.wb.add_chart({"type": kind, **k})
        ch.set_chartarea({"border": {"none": True}})
        ch.set_plotarea({"border": {"none": True}})
        ch.set_legend({"position": "bottom", "font": {"size": 9}})
        return ch

    def sheet_summary(self):
        ws, p, A = self.ws["Summary"], self.p, self.A
        meta, t = p["meta"], p.get("terminal") or {}
        ws.set_column(0, 0, 2)
        ws.set_column(1, 1, 30)
        ws.set_column(2, 2, 16)
        ws.set_column(3, 3, 3)
        ws.set_column(4, 4, 30)
        ws.set_column(5, 5, 16)
        ws.set_column(6, 20, 9)
        ws.write(0, 1, f"{meta.get('name')} ({meta.get('sym')})", self.title())
        ws.write(1, 1, f"Discounted cash flow valuation · generated {meta.get('generated', '')[:16].replace('T', ' ')} UTC · {meta.get('source')}"
                 + (f" · cost of capital: Damodaran ({meta.get('damIndustry')}, {meta.get('damCountry')})" if meta.get("damIndustry") else ""), self.sub())
        kpis = [("Value per share", "=ValuePerShare", t.get("perShare"), self.PRICE), ("Current share price", "=SharePrice", A.get("price"), self.PRICE), ("Upside / (downside)", "=Upside", t.get("upside"), self.PCT),
                ("Enterprise value ($m)", "=EnterpriseValue", _f(t.get("ev"), 0) / 1e6, self.MONEY), ("Equity value ($m)", "=EquityValue", _f(t.get("equity"), 0) / 1e6, self.MONEY),
                ("Probability-weighted (scenarios)", "=ScenarioValue", (p.get("scen") or {}).get("pw"), self.PRICE), ("Monte Carlo median", "=MCMedian", (p.get("mc") or {}).get("p50"), self.PRICE)]
        ass = [("WACC, high-growth years", "=WACCHigh", (p.get("coc") or {}).get("W0"), self.PCT2), ("WACC, stable growth", "=WACCStable", (p.get("coc") or {}).get("WS"), self.PCT2),
               ("Cost of equity", "=CostEquity", (p.get("coc") or {}).get("ke"), self.PCT2), ("Beta used", "=BetaUsed", (p.get("coc") or {}).get("beta"), self.NUM2),
               ("Revenue growth, high-growth years", "=GrowthHigh", A.get("g1"), self.PCT), ("Target EBIT margin", "=MarginTarget", A.get("marginTarget"), self.PCT),
               ("Terminal growth", "=GrowthTerminal", A.get("termGrowth"), self.PCT2), ("Terminal value share of EV", "=TVShare", t.get("tvShare"), self.PCT)]
        ws.write(3, 1, "Valuation", self.sect())
        ws.write(3, 2, "", self.sect())
        for i, (lab, fx, v, nf) in enumerate(kpis):
            ws.write(4 + i, 1, lab, self.lab(i < 3))
            ws.write_formula(4 + i, 2, fx, self.key(nf) if i in (0, 2) else self.link(nf), _f(v))
        ws.write(3, 4, "Key assumptions", self.sect())
        ws.write(3, 5, "", self.sect())
        for i, (lab, fx, v, nf) in enumerate(ass):
            ws.write(4 + i, 4, lab, self.lab())
            ws.write_formula(4 + i, 5, fx, self.link(nf), _f(v))
        ws.conditional_format(6, 2, 6, 2, {"type": "cell", "criteria": ">=", "value": 0, "format": self.F(font_color="#047857", bold=True)})
        ws.conditional_format(6, 2, 6, 2, {"type": "cell", "criteria": "<", "value": 0, "format": self.F(font_color="#B91C1C", bold=True)})

        CD = "Chart data"
        h0, h1 = self.cd_hist
        f0, f1 = self.cd_fc
        a0, a1 = self.cd_all
        navy, sky, amber, green, grey, red = "#1F3A5F", "#3B82F6", "#F59E0B", "#10B981", "#9CA3AF", "#EF4444"
        # 1. revenue (columns) + FCFF (smooth line)
        c1 = self.chart("column")
        c1.add_series({"name": "Revenue, actual", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 1, a1, 1], "fill": {"color": grey}, "gap": 60})
        c1.add_series({"name": "Revenue, forecast", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 2, a1, 2], "fill": {"color": sky}, "overlap": 100})
        l1 = self.chart("line")
        l1.add_series({"name": "Free cash flow", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 3, a1, 3], "smooth": True, "line": {"color": amber, "width": 2.5},
                       "marker": {"type": "circle", "size": 5, "fill": {"color": amber}, "border": {"color": amber}}})
        c1.combine(l1)
        c1.set_title({"name": "Revenue and free cash flow ($m)", "name_font": {"size": 11}})
        c1.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
        ws.insert_chart("B14", c1, {"x_scale": 1.25, "y_scale": 1.05})
        # 2. growth path (smooth)
        c2 = self.chart("line")
        c2.add_series({"name": "Growth, actual", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 4, a1, 4], "smooth": True, "line": {"color": grey, "width": 2}, "marker": {"type": "circle", "size": 5}})
        c2.add_series({"name": "Growth, forecast", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 5, a1, 5], "smooth": True, "line": {"color": sky, "width": 2.75}, "marker": {"type": "circle", "size": 4}})
        c2.set_title({"name": "Revenue growth: history and forecast path", "name_font": {"size": 11}})
        c2.set_y_axis({"num_format": "0%", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
        ws.insert_chart("H14", c2, {"x_scale": 1.25, "y_scale": 1.05})
        # 3. margin, ROIC, WACC (smooth)
        c3 = self.chart("line")
        c3.add_series({"name": "EBIT margin", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 6, a1, 6], "smooth": True, "line": {"color": sky, "width": 2.5}})
        c3.add_series({"name": "ROIC", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 7, a1, 7], "smooth": True, "line": {"color": green, "width": 2.5}})
        c3.add_series({"name": "Cost of capital", "categories": [CD, a0, 0, a1, 0], "values": [CD, a0, 8, a1, 8], "smooth": True, "line": {"color": amber, "width": 2.25, "dash_type": "dash"}})
        c3.set_title({"name": "EBIT margin, return on capital and cost of capital", "name_font": {"size": 11}})
        c3.set_y_axis({"num_format": "0%", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
        ws.insert_chart("B31", c3, {"x_scale": 1.25, "y_scale": 1.05})
        # 4. cumulative PV (area) vs enterprise value
        c4 = self.chart("area")
        c4.add_series({"name": "Cumulative PV of FCFF", "categories": [CD, f0, 0, f1, 0], "values": [CD, f0, 9, f1, 9], "fill": {"color": sky, "transparency": 35}, "line": {"color": sky, "width": 2}})
        l4 = self.chart("line")
        l4.add_series({"name": "Enterprise value (incl. terminal value)", "categories": [CD, f0, 0, f1, 0], "values": [CD, f0, 10, f1, 10], "line": {"color": navy, "width": 2, "dash_type": "dash"}})
        c4.combine(l4)
        c4.set_title({"name": "Where the value comes from ($m)", "name_font": {"size": 11}})
        c4.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
        ws.insert_chart("H31", c4, {"x_scale": 1.25, "y_scale": 1.05})
        # 5. EV-to-equity waterfall
        b0, b1 = self.cd_bridge
        c5 = self.chart("column", subtype="stacked")
        c5.add_series({"name": "base", "categories": [CD, b0, 0, b1, 0], "values": [CD, b0, 1, b1, 1], "fill": {"none": True}, "border": {"none": True}})
        c5.add_series({"name": "Increase", "categories": [CD, b0, 0, b1, 0], "values": [CD, b0, 2, b1, 2], "fill": {"color": green}, "gap": 40})
        c5.add_series({"name": "Decrease", "categories": [CD, b0, 0, b1, 0], "values": [CD, b0, 3, b1, 3], "fill": {"color": red}})
        c5.add_series({"name": "Total", "categories": [CD, b0, 0, b1, 0], "values": [CD, b0, 4, b1, 4], "fill": {"color": navy}, "data_labels": {"value": True, "num_format": "#,##0;-#,##0;;", "font": {"size": 8}}})
        c5.set_title({"name": "Enterprise value to equity ($m)", "name_font": {"size": 11}})
        c5.set_legend({"none": True})
        c5.set_y_axis({"num_format": "#,##0", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
        ws.insert_chart("B48", c5, {"x_scale": 1.25, "y_scale": 1.05})
        # 6. football field (stacked bar, invisible low)
        fr0, fr1 = self.foot_rows
        if fr1 >= fr0:
            c6 = self.chart("bar", subtype="stacked")
            c6.add_series({"name": "low", "categories": ["Scenarios", fr0, 0, fr1, 0], "values": ["Scenarios", fr0, 1, fr1, 1], "fill": {"none": True}, "border": {"none": True}})
            c6.add_series({"name": "Value range", "categories": ["Scenarios", fr0, 0, fr1, 0], "values": ["Scenarios", fr0, 3, fr1, 3], "fill": {"color": sky}, "gap": 50})
            c6.set_title({"name": f"Valuation range per share (price {(_f(A.get('price'), 0)):,.2f})", "name_font": {"size": 11}})
            c6.set_legend({"none": True})
            c6.set_y_axis({"reverse": True})
            c6.set_x_axis({"num_format": "#,##0", "major_gridlines": {"visible": True, "line": {"color": "#E5E7EB"}}})
            ws.insert_chart("H48", c6, {"x_scale": 1.25, "y_scale": 1.05})
        # 7. cost of capital build-up
        r0, r1 = self.cd_coc
        c7 = self.chart("bar")
        c7.add_series({"name": "Cost of capital", "categories": [CD, r0, 0, r1, 0], "values": [CD, r0, 1, r1, 1], "fill": {"color": navy}, "gap": 40,
                       "data_labels": {"value": True, "num_format": "0.00%", "font": {"size": 8}}})
        c7.set_x_axis({"num_format": "0%"})
        c7.set_title({"name": "Cost of capital build-up", "name_font": {"size": 11}})
        c7.set_legend({"none": True})
        c7.set_y_axis({"reverse": True})
        ws.insert_chart("B65", c7, {"x_scale": 1.25, "y_scale": 1.25})
        # 8. Monte Carlo histogram
        m0, m1 = self.mc_rows
        if m1 >= m0:
            c8 = self.chart("column")
            c8.add_series({"name": "Runs", "categories": ["Scenarios", m0, 3, m1, 3], "values": ["Scenarios", m0, 2, m1, 2], "fill": {"color": sky}, "gap": 8})
            c8.set_title({"name": "Monte Carlo: value per share (4,000 runs)", "name_font": {"size": 11}})
            c8.set_legend({"none": True})
            c8.set_x_axis({"num_font": {"rotation": -45, "size": 7}})
            ws.insert_chart("H65", c8, {"x_scale": 1.25, "y_scale": 1.25})
        # 9. company vs industry
        br0, br1 = self.bench_rows
        if br1 >= br0:
            c9 = self.chart("bar")
            sheet = "Peers & industry"
            s0, s1 = self.cd_bench
            if s1 >= s0:
                for j, (nm, colr) in enumerate(((meta.get("sym") or "Company", sky), ((p.get("damodaran") or {}).get("industryName") or "Industry", amber), ("US market", grey))):
                    c9.add_series({"name": nm, "categories": [CD, s0, 0, s1, 0], "values": [CD, s0, 1 + j, s1, 1 + j], "fill": {"color": colr}, "gap": 60})
                c9.set_title({"name": "Company vs Damodaran industry and market", "name_font": {"size": 11}})
                c9.set_x_axis({"num_format": "0%"})
                c9.set_y_axis({"reverse": True})
                ws.insert_chart("B84", c9, {"x_scale": 2.45, "y_scale": 1.3})
        ws.write(102, 1, "Charts and figures update when you change the blue inputs on the Inputs, Drivers or DCF sheets (sensitivity, scenario and Monte Carlo tables are values from Agula).", self.note())

    # ------------------------------------------------------------------ Notes
    def sheet_notes(self):
        ws, p = self.ws["Notes"], self.p
        meta = p["meta"]
        lines = [
            ("Agula Terminal — DCF model", self.title()),
            (f"{meta.get('name')} ({meta.get('sym')}) · generated {meta.get('generated', '')[:16].replace('T', ' ')} UTC", self.sub()),
            ("", None),
            ("How the model works", self.sect()),
            ("Free cash flow to the firm (FCFF) = EBIT × (1 − tax rate) − reinvestment.", None),
            ("Reinvestment = increase in revenue ÷ sales-to-capital ratio (Damodaran), or capex − D&A + increase in working capital (itemised).", None),
            ("Revenue grows at the high-growth rate for the high-growth years, then fades linearly to the terminal growth rate by the last forecast year.", None),
            ("The EBIT margin moves linearly from today's margin to the target margin by the chosen year. Tax moves from the effective rate to the marginal rate after the high-growth years.", None),
            ("Cost of capital: industry unlevered beta (Damodaran, corrected for cash) relevered at the company's market debt-to-equity; cost of equity = risk-free + beta × (implied ERP + country risk).", None),
            ("Cost of debt = risk-free + default spread for the synthetic rating implied by interest coverage (Damodaran's table) + country default spread; tax-deductible at the marginal rate.", None),
            ("After the high-growth years the cost of capital fades to the stable-period WACC (stable beta, industry debt ratio). Discount factors compound year by year.", None),
            ("Terminal value = FCFF(N+1) ÷ (stable WACC − g), where FCFF(N+1) = NOPAT(N+1) × (1 − g ÷ stable ROIC): growth must be paid for with reinvestment.", None),
            ("With mid-year discounting, year-t cash flows are discounted half a year less; the stable-growth value is adjusted the same way.", None),
            ("Forecast drivers come from the company's historical ratios (average, recent-weighted, median, latest, trend, CAGR) or Damodaran industry averages; see the Drivers sheet.", None),
            ("", None),
            ("Colour code", self.sect()),
            ("Blue on yellow = input you can change · green = link to another sheet · black = formula.", None),
            ("", None),
            ("Sources", self.sect()),
            (f"Financial statements and prices: {meta.get('source')}; check important figures against the company's annual report.", None),
            ("Cost of capital and industry data: Aswath Damodaran, NYU Stern (pages.stern.nyu.edu/~adamodar), January industry tables and the monthly implied ERP.", None),
            ("Risk-free rate: 10-year US Treasury yield (US Treasury / FRED).", None),
            ("", None),
            ("For research and education. Not investment advice.", self.F(bold=True)),
        ]
        for i, (txt, fmt) in enumerate(lines):
            ws.write(i, 0, txt, fmt) if fmt else ws.write(i, 0, txt)
        ws.set_column(0, 0, 150)


def build_dcf_workbook(payload: dict) -> bytes:
    if not isinstance(payload, dict) or not payload.get("rows") or not payload.get("A") or not payload.get("meta"):
        raise HTTPException(400, "Incomplete model: open the DCF screen and export again.")
    if len(payload.get("rows") or []) > 15:
        raise HTTPException(400, "Too many forecast years.")
    return _DcfBook(payload).build()


# =============================================================================
# Background warming (always-on hosts): keeps first visits fast
# =============================================================================
def _warm_loop():
    time.sleep(2)
    while True:
        t0 = time.time()
        for name, fn in (("curve", get_curve), ("macro", get_macro), ("calendar", get_calendar), ("universe", get_universe), ("news", get_headlines), ("damodaran", get_damodaran),
                         ("quotes", lambda: get_quotes(SECTOR_ETFS + [BENCH, "^VIX", "^TNX", "DX-Y.NYB", "CL=F", "GC=F", "BTC-USD"]))):
            try:
                fn()
            except Exception as exc:
                log.info("warm %s failed: %s", name, exc)
        log.info("warm cycle done in %.1fs", time.time() - t0)
        time.sleep(int(os.environ.get("AGULA_WARM_INTERVAL", "1500")))


# =============================================================================
# The terminal page (HTML + CSS + JavaScript). build.py embeds it here in agula.py.
# =============================================================================
PAGE_HTML = None  # @@EMBEDDED_PAGE@@


if __name__ == "__main__":
    import webbrowser
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    hosted = any(os.environ.get(k) for k in ("RENDER", "K_SERVICE", "CLOUDFLARE_APPLICATION_ID", "DYNO", "RAILWAY_ENVIRONMENT"))
    host = os.environ.get("HOST", "0.0.0.0" if hosted else "127.0.0.1")   # platforms need 0.0.0.0; your PC stays private
    if hosted:
        os.environ["NO_BROWSER"] = "1"
    url = f"http://localhost:{port}"
    print("\n" + "=" * 62 + f"\n  Agula Terminal is starting. Open {url}\n  Keep this window open; press Ctrl+C to stop.\n" + "=" * 62 + "\n", flush=True)
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(2.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port, log_level="info", proxy_headers=True, forwarded_allow_ips="*")
