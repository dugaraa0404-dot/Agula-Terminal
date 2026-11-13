# Agula Terminal

A keyboard-first market terminal in the browser, running on real market data.
**The whole application is one Python file, `agula.py`.** It fetches and caches the
data, and serves the terminal page, which is embedded inside it.

| Key | Function | What it shows |
|-----|----------|---------------|
| F1  | HELP  | Every function, command and shortcut |
| F2  | MON   | Indices, Treasury yields, FX (incl. USD/MNT), commodities, crypto, S&P heatmap, movers, breadth, sectors, market regime |
| F3  | LP    | **Launchpad**: 2–6 tiles, each its own function and security; link tiles by colour so they follow each other; save, load, export layouts |
| F4  | DES   | Quote, chart, key statistics, performance and risk, analyst targets, profile, financials, news; live Binance order book for crypto |
| F5  | CHART | Candles from 1-minute to weekly, 8 overlays, 5 indicators, price levels, return statistics, comparison (`CMP AAPL MSFT NVDA`) |
| F6  | DCF   | Damodaran-style valuation with cost of capital from Damodaran's data, history-based drivers, scenarios, Monte Carlo, reverse DCF, Excel model |
| F7  | OPT   | Real option chains, Greeks, IV smile, volatility surface, strategy builder, pricer |
| F8  | PORT  | Positions, VaR/CVaR (4 methods), backtest, efficient frontier, risk parity, correlation, stress tests |
| F9  | BOT   | **Trading bot**: backtest 6 strategies with costs, optimize parameters, run **paper-trading bots** with stops, limits and a kill switch |
| F10 | GEO   | **Geopolitical risk map** built from the latest headlines. **Every country can be opened**: click it on the map, pick it from the all-countries list (filter by region, sort by risk or A–Z), type its name, or step with ◀ ▶ / ← →. Each gets a situation brief from its own news search (themes, escalation, risk, linked markets, headlines) and a **News vs prices** analysis. That analysis compares 30 days of the country's headlines with its markets (country ETF or index, currency, commodities): moves on busy-news vs quiet days, the move in the ~4 trading hours after each major headline, whether escalation news moved prices the risk-off way, and whether today's move is unusual |
| F11 | NEWS  | Market news by theme, each next to the prices it moves |
| F12 | ALRT  | **Alerts manager**: price and day-move alerts, repeat, sound and browser notifications, bot trades |

More functions (type the code, or press the yellow market keys at the bottom left):

| Code | Function |
|------|----------|
| YAS (also BOND) | **Bond yield & spread analysis**: price ↔ yield, yield to call / worst, Macaulay, modified and effective duration, convexity, DV01, G- and Z-spread to the Treasury curve, key-rate durations, rate-shock table, holding-period return and breakeven, a bond portfolio with immunization check, and a plain-language explanation of every result |
| CURVE | US Treasury curve: NSS fit, zero and forward curves, curve shifts, compact bond calculator |
| WEI · GLCO · CRYP | World equity indices by region · commodities · crypto, with 1W/1M/YTD/1Y, 52-week range, session status |
| IMAP | Sector heatmap of 65 US large caps, 1D to 1Y |
| MOST | Gainers, losers, most active, unusual volume, near 52-week highs/lows |
| EVTS | Earnings calendar with EPS estimates (Nasdaq) |
| CORR | Correlation matrix with clustering and rolling correlation |
| FX · SCRN · ECO · SET | FX cross rates · screener · economic calendar · settings (theme, refresh, bot token) |

**Bloomberg-style commands.** `AAPL US EQUITY DES <GO>`, `7203 JP EQUITY GP`, `SPX INDEX`, `EURUSD CURNCY`, `CL1 COMDTY`,
`GT10 GOVT`, or a yellow key alone (`INDEX`, `CMDTY`, `GOVT`) to open that market. Press **1–9** to open the numbered related
functions under each screen title. `ALERT NVDA > 200`, `ALERT TSLA -5%`. The Classic theme (SET) is black and amber like a Bloomberg screen.

Type a ticker and a function in the command line: `NVDA DES`, `AAPL DCF`, `SPY OPT`, `BTC CHART`, `NVDA BOT`, `BOND`.

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
dev/                 source for editing: agula_server.py, src/*.js|css|html, build.py, geo/ (world map builder)
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
| `AGULA_RATE_LIMIT` | 600 | API requests per minute per visitor (each Launchpad tile polls on its own) |
| `AGULA_DATA_DIR` | `./agula-data` | Where paper bots are saved. On a server, point it at a persistent disk |
| `AGULA_BOT_TOKEN` | — | If set, only browsers that enter this token in SET can create, stop or trade bots (recommended on a public server) |
| `AGULA_BOT_TICK` | 30 | Seconds between paper-bot checks |
| `AGULA_BOTS` | 1 | `0` turns the paper-trading engine off |
| `AGULA_BOT_MAX` | 25 | Maximum number of bots |
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
| NEWS themes, extra company headlines, GEO map | Google News RSS (tagged by country and theme on the server) |
| Earnings calendar (EVTS) | Nasdaq's public earnings calendar; Yahoo company calendars as a fallback |
| World map (GEO) | Natural Earth 1:110m countries (public domain) via world-atlas, drawn in the Natural Earth projection |
| Mongolian policy rate (MNT carry) | Entered in the code (`RATE_FALLBACK["MNT"]`, 12.5%); update when the Bank of Mongolia changes it |

For research only, not investment advice. Check anything important against an official source.

## Trading bot (F9 BOT)

**Paper trading only: simulated money on real, delayed prices. Agula never sends an order to a broker.**

* **Strategies:** moving-average crossover, MACD, RSI mean reversion, Bollinger reversion, Donchian breakout, time-series momentum, and Manual (trade by hand). Long only, or long and short.
* **Backtest:** the signal is taken on a closed bar and filled at the next bar's open (no look-ahead), with commission and slippage. Stop-loss, take-profit and trailing stop are checked inside each bar. Results: return vs buy & hold, CAGR, Sharpe, Sortino, max drawdown, win rate, profit factor, trades, monthly returns, and an **out-of-sample** split to show overfitting.
* **Optimize:** a grid of up to 144 backtests over two parameters, scored by Sharpe, return, CAGR, Calmar or drawdown.
* **Paper bots:** a background engine on the server checks every bot every 30 seconds. It acts on each closed bar's signal and applies stops, a daily loss limit (pauses until the next day) and a max-drawdown halt. US stocks trade only in the regular session unless you turn that off. Each bot has a manual order ticket, an equity curve, an order list and a log. Trades also appear as alerts. The **kill switch** stops every bot and closes every position.
* **Keeping bots:** bots are saved to `AGULA_DATA_DIR`. Free cloud plans (Render free) erase that disk and stop the engine while the service sleeps. Agula therefore keeps a backup of your bots in your browser and offers to restore them, and **Export / Import** saves them as a file. For bots that keep running around the clock, use an always-on plan with a persistent disk. Set `AGULA_BOT_TOKEN` on public servers.

## Bond analysis (YAS)

Enter a coupon, maturity, frequency (or zero coupon), day count (ACT/ACT, 30/360, ACT/360, ACT/365), settlement date and a yield, clean price or spread to the Treasury curve; optionally a call date and price. Presets cover generic 2/5/10/30-year Treasuries (coupon set from today's curve), an investment-grade and a high-yield corporate, a 10-non-call-3 callable and a 20-year zero.
It shows clean and dirty price, accrued interest, yield to maturity, call and worst, current yield, Macaulay / modified / effective duration, convexity, DV01, G- and Z-spread, and key-rate durations. It also runs a rate-shock table from −300bp to +300bp comparing exact repricing with the duration and duration + convexity estimates, holding-period total return, and the breakeven yield rise. A "where the duration comes from" picture shows the payments as weights balancing at the Macaulay duration, and the interpretation explains each number in plain words. Add bonds to a portfolio to see value-weighted duration, DV01, ±100bp P&L and whether it is immunized for the date you need the money.
Formulas use street conventions (yield compounded at the coupon frequency, zero-coupon bonds semi-annually); results match a textbook calculation to every decimal.

## Changing the app

Edit the files in `dev/` (server: `dev/agula_server.py`; page: `dev/src/`), then run
`python dev/build.py`. It regenerates `agula.py` with the page embedded.
`python dev/build.py --html` also writes `agula_terminal.html` for inspection. While that file sits next to `agula.py`, the
server serves it instead of the embedded page, so delete it before you deploy.

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
GET  /api/perf?symbols=...                  1W/1M/3M/YTD/1Y, 52-week range, 20-day volume
GET  /api/earnings                          earnings calendar, two weeks ahead
GET  /api/geo                               geopolitical headlines tagged by country, sea lane and theme, with risk scores
GET  /api/geo/country?name=Mongolia&region=Asia-Pacific   one country's situation from its own news search
GET  /api/geo/reaction?name=Mongolia&region=Asia-Pacific  30 days of that country's news vs the price moves of its markets
GET  /api/bot/strategies  /api/bot/list  /api/bot/{id}  /api/bot/events?since=ms  /api/bot/export
POST /api/bot/backtest  /api/bot/sweep       (JSON: symbol, tf, strategy, params, risk, oos_pct)
POST /api/bot  /api/bot/{id}/start|stop|reset|delete|update|order  /api/bot/kill  /api/bot/import   (x-agula-token if set)
```
