# Agula Terminal

A keyboard-first market terminal in the browser, running on real market data.
**The whole application is one Python file, `agula.py`.** It fetches and caches the
data, and serves the terminal page, which is embedded inside it.

| Key | Function | What it shows |
|-----|----------|---------------|
| F1  | HELP  | Commands and shortcuts |
| F2  | MON   | Indices, Treasury yields, FX (incl. USD/MNT), commodities, crypto, S&P heatmap, movers, breadth, sectors, market regime |
| F3  | DES   | Quote, chart, key statistics, performance and risk, analyst targets, profile, financials, news; live Binance order book for crypto |
| F4  | CHART | Candles from 1-minute to weekly, 8 overlays, 5 indicators, price levels, return statistics, comparison (`CMP AAPL MSFT NVDA`) |
| F5  | DCF   | Damodaran-style free-cash-flow valuation: cost of capital from **Damodaran's data**, forecast drivers from the company's history (several methods) or the industry, sensitivities, scenarios, Monte Carlo, reverse DCF, peers, and an **Excel model with live formulas, charts and tables** |
| F6  | OPT   | Real option chains, Greeks, IV smile, volatility surface, term structure, strategy builder and payoff, pricer |
| F7  | PORT  | Positions, VaR/CVaR (4 methods), backtest, efficient frontier, risk parity, correlation, factor stress tests |
| F8  | CURVE | US Treasury par curve, NSS fit, zero and forward curves, curve shifts, bond calculator, key-rate durations |
| F9  | FX    | Cross rates, converter, forwards, carry-to-risk, correlations |
| F10 | SCRN  | 65 US large caps; filter with expressions like `pe < 20 and fcfy > 4%` |
| F11 | ECO   | US economic calendar and macro dashboard |
| F12 | NEWS  | Market news by theme (Fed, inflation, geopolitics, energy, China/Asia, tech, earnings, crypto, Mongolia), each next to the prices it moves, with a "heat" score for how hard each theme is moving markets today |

Type a ticker and a function in the command line: `NVDA DES`, `AAPL DCF`, `SPY OPT`, `BTC CHART`.

## What's in this package

```
agula.py             THE APP: server + API + embedded page (the "whole Python code")
requirements.txt     Python packages
.python-version      Python 3.12 (Render reads this)
render.yaml          Render Blueprint (one-click deploy)
Procfile             start command for Render/Railway/Heroku-style hosts
Dockerfile           container image (Cloudflare Containers, any Docker host)
wrangler.jsonc       Cloudflare config
worker/index.js      20-line Cloudflare front door that forwards requests to agula.py
package.json         Cloudflare tooling (wrangler)
run_windows.bat      local start, Windows
run_mac_linux.sh     local start, macOS/Linux
.env.example         optional API keys
dev/                 source for editing: agula_server.py, src/*.js|css|html, build.py
```

## 1. Run it on your computer

Requires Python 3.10+. Windows: double-click `run_windows.bat`. macOS/Linux: `./run_mac_linux.sh`. Or:

```bash
pip install -r requirements.txt
python agula.py
```

Your browser opens **http://localhost:8000**. Use `localhost` in the browser, never `0.0.0.0`.

## 2. Deploy on Render

1. Put this folder in a GitHub repository (GitHub → New repository → upload the files,
   keeping `.python-version` and the `worker/` and `dev/` folders).
2. Render dashboard → **New → Blueprint** → choose the repository → **Apply**.
   Render reads `render.yaml`, asks for the optional FRED key (leave blank to skip), builds,
   and gives you a URL like `https://agula-terminal.onrender.com`.

Manual alternative: **New → Web Service** → your repo → Runtime **Python 3** →
Build `pip install -r requirements.txt` →
Start `uvicorn agula:app --host 0.0.0.0 --port $PORT --workers 1` → Health check path `/health`.

What to expect:
- **Free plan:** the service sleeps after 15 minutes without visitors and takes about a minute
  to wake. It has 750 free hours a month. Agula uses about 150 MB of the 512 MB memory.
  A paid instance stays awake and keeps its cache warm.
- **Region:** `render.yaml` uses Singapore, the closest region to Mongolia. Change it before the
  first deploy if you like; it can't be changed later.
- **Yahoo rate limits:** Yahoo sometimes rate-limits shared cloud IP addresses, and it often refuses
  cloud servers the session token its options endpoint needs. Agula then serves option chains from
  Cboe's public delayed quotes, keeps serving its last good data elsewhere, and says clearly when
  something can't be loaded. If Yahoo blocks constantly, use Cloudflare Tunnel (section 3B), which
  uses your own internet connection.
- **FRED timeouts:** FRED can be slow from cloud servers. The yield curve comes from the US Treasury
  first, so it doesn't depend on FRED. For the macro dashboard, add a free `FRED_API_KEY` in Render's
  Environment settings; Agula then uses FRED's official API, which is more reliable.
- **Adding the FRED key later:** Render asks for `FRED_API_KEY` only when the Blueprint is first
  created. To add it afterwards: your service → **Environment** → **Add Environment Variable** → Save.
  Render redeploys automatically, and the header chip changes from **FRED** to **FRED + CAL**.
- **Updating an existing Render site:** push the new files to the same GitHub repository. Render
  redeploys on each commit (`autoDeployTrigger: commit`); or click **Manual Deploy → Deploy latest commit**.

## 3. Deploy on Cloudflare

Cloudflare's **Python Workers** can't run Agula: they run Python inside WebAssembly, where
threads don't work and `yfinance`'s networking library (`curl_cffi`) isn't available.
These two Cloudflare options run the same `agula.py` unchanged.

### 3A. Cloudflare Containers (always online, Workers Paid plan)

Cloudflare runs `agula.py` in a container; the small Worker in `worker/index.js` routes
your `*.workers.dev` URL to it. Needs the **Workers Paid plan**, Node.js 18+, and
**Docker Desktop running** on your computer (wrangler builds the image locally).

```bash
npm install
npx wrangler login
npx wrangler secret put FRED_API_KEY        # optional (release calendar)
npx wrangler deploy
```

The first deploy uploads the image; the container may take a few minutes to become
available. After 30 idle minutes the container stops, and the next visit starts it again
in a few seconds (`sleepAfter` in `worker/index.js`). Instance size is `basic`
(1/4 vCPU, 1 GiB) in `wrangler.jsonc`; use `standard-1` if it feels slow.
Logs: `npx wrangler tail`.

### 3B. Cloudflare Tunnel (free, runs on your computer)

Run Agula on your own computer and let Cloudflare give it a public HTTPS address. It's free,
needs no server, and Yahoo sees your normal home IP. The site is online while your computer is.

1. Install `cloudflared`: https://developers.cloudflare.com/tunnel/downloads/
2. Start Agula: `python agula.py`
3. In a second window: `cloudflared tunnel --url http://localhost:8000`

It prints a public `https://….trycloudflare.com` address. No Cloudflare account is needed.
The address changes every time you restart the tunnel, and it's meant for testing and
sharing, with no uptime guarantee. For a permanent address on your own domain, follow
Cloudflare's tunnel guide (https://developers.cloudflare.com/tunnel/get-started/) and point the
tunnel at `http://localhost:8000`.

## 4. Any other host (Docker)

```bash
docker build -t agula .
docker run -p 8080:8080 -e FRED_API_KEY=... agula
```

Works on Railway, Fly.io, Google Cloud Run, or a VPS. Always run **one** worker process,
so every visitor shares one cache.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 8000 (local), 8080 (Docker) | Listening port; Render and Cloudflare set it |
| `HOST` | 127.0.0.1 locally, 0.0.0.0 on Render/Cloudflare | Listening address |
| `FRED_API_KEY` | — | Official FRED release calendar (free key) |
| `AGULA_RATE_LIMIT` | 240 | API requests per minute per visitor |
| `AGULA_IP_HEADER` | — | Header holding the visitor's IP (`cf-connecting-ip` on Cloudflare; set automatically) |
| `AGULA_CACHE_DIR` | — | Folder for an on-disk cache of slow data |
| `AGULA_WARM` | 1 | Pre-load curve, macro, calendar and screener in the background |
| `AGULA_WARM_INTERVAL` | 1500 | Seconds between warm-ups |
| `AGULA_QUOTE_TTL` | 20 | Seconds a quote is reused |
| `AGULA_DAMODARAN_URL` | https://pages.stern.nyu.edu/~adamodar | Where Damodaran's data files are downloaded from (a mirror, if you keep one) |
| `ALLOWED_ORIGINS` | * | CORS origins if the page is hosted on another domain |
| `NO_BROWSER` | — | Don't open a browser tab on start |

Locally you can put these in a `.env` file next to `agula.py` (see `.env.example`).
API keys stay on the server; the browser never sees them. `GET /health` shows the status.

## The DCF model (F5)

**Cost of capital, from Aswath Damodaran's data (NYU Stern).** The server downloads his files
(industry betas, cost of capital, margins, sales-to-capital, working capital, tax rates, returns on
capital, revenue growth, country risk premiums, the synthetic-rating table and the monthly implied
equity risk premium), keeps them for a day, and matches the company to one of his ~95 industries
(you can pick another, and another country).

- Beta: the industry's unlevered beta (corrected for cash) relevered at the company's market
  debt-to-equity, βL = βU × (1 + (1 − t) × D/E). Or Yahoo's regression beta, the industry levered beta, or your own.
- Cost of equity = 10-year Treasury + beta × (implied ERP + country risk adjustment).
- Cost of debt = Treasury + the default spread for the synthetic rating implied by interest coverage
  (EBIT ÷ interest) + the country's default spread; or interest ÷ debt; or your own.
- After the high-growth years the cost of capital fades to a stable-growth WACC (beta → 1, industry debt ratio).

**Forecast drivers from history.** Revenue growth, target EBIT margin, effective tax rate,
sales-to-capital, D&A, capex and working capital are each computed from the company's past years by a
method you pick (average, recent-weighted average, median, latest year, linear trend, CAGR) or taken
from the Damodaran industry average, or typed in. Use the last 3 years or all years.

**Model.** FCFF = EBIT × (1 − tax) − reinvestment, with reinvestment = Δ revenue ÷ sales-to-capital
(or capex − D&A + working capital). Growth, the tax rate (effective → marginal) and the cost of capital
fade to stable values; the terminal value reinvests g ÷ ROIC, so growth is never free. Exit-multiple and
blended terminal values, mid-year discounting, per-year growth and margin edits are available.

**Excel export.** Built on the server: Summary dashboard with nine native charts (smooth lines,
areas, waterfall, football field, histogram), Inputs, Cost of capital, DCF and Drivers sheets with
live formulas (blue cells are inputs), colour-scaled sensitivity grids, scenarios and Monte Carlo,
Excel tables of historicals, peers and Damodaran's data, and notes. Every formula also stores the
value shown on screen; recalculated from scratch, the workbook reproduces Agula's value exactly.

If Damodaran's site can't be reached, the DCF still works with labelled fallbacks (the January 2026
implied ERP of 4.23%, Yahoo's beta, interest ÷ debt) and says so.

## Data sources

| Data | Source |
|------|--------|
| Quotes, history, profiles, statements, options, news, search | Yahoo Finance via `yfinance` (delayed, unofficial) |
| Option chains when Yahoo refuses the server | Cboe delayed quotes (15 min, public) |
| Treasury yield curve and spreads | US Treasury daily par yield curve (official); backups: FRED, then Yahoo's 4 yield indices |
| Macro indicators, policy rates | FRED, St. Louis Fed (the free FRED_API_KEY makes it more reliable) |
| Cost of capital, industry benchmarks, country risk, implied ERP | Aswath Damodaran, NYU Stern (pages.stern.nyu.edu/~adamodar), refreshed daily |
| Crypto order book and trades | Binance public market data |
| NEWS themes and extra company headlines | Google News RSS |
| Mongolian policy rate (MNT carry) | Entered in the code (`RATE_FALLBACK["MNT"]`, 12.5%); update when the Bank of Mongolia changes it |

For research only, not investment advice. Check anything important against an official source.

## Changing the app

Edit the files in `dev/` (server: `dev/agula_server.py`; page: `dev/src/`), then run
`python dev/build.py`. It regenerates `agula.py` with the page embedded.
`python dev/build.py --html` also writes `agula_terminal.html` for inspection.

## API

```
GET  /health
GET  /api/quotes?symbols=AAPL,MSFT          GET /api/history?symbol=AAPL&tf=1D   (1m 5m 1H 1D 1W)
GET  /api/profile?symbol=AAPL               GET /api/fundamentals?symbol=AAPL
GET  /api/options?symbol=AAPL               GET /api/options/chain?symbol=AAPL&expiry=2026-11-20
GET  /api/options/surface?symbol=AAPL&spot=232
GET  /api/curve  /api/macro  /api/calendar  /api/fx/rates  /api/universe
GET  /api/news?symbol=AAPL  /api/book?symbol=BTC-USD  /api/search?q=tesla
GET  /api/sparks?symbols=...  /api/meta?symbols=...
GET  /api/headlines                         news by theme, with the symbols each theme moves
GET  /api/damodaran?industry=&sector=&country=   Damodaran's tables + the matched industry and country
POST /api/dcf/xlsx                           Excel model from the DCF screen's model (JSON in, .xlsx out)
```
