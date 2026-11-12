# AGULA Terminal — Render upgrade overlay

This is an **overlay**, not a replacement for AGULA's existing financial terminal. Run `python install_into_agula.py /path/to/Agula-Terminal`, or copy the overlay files into the **root of the existing AGULA GitHub repository** (same directory as `agula.py` and `requirements.txt`), preserving the included directories. Copy `render.yaml` and `Procfile` over the existing deployment files.

## Project requirements

- The original repo's `agula.py` must remain in place.
- The original repo's `trading/paper_bot.py` must remain in place.
- Existing `requirements.txt` already includes FastAPI, Uvicorn, yfinance, and pandas; no new third-party packages are needed.
- Start command changes from `uvicorn agula:app` to `uvicorn render_app:app`; this imports all preexisting routes and adds `/algo` and `/api/algo/...`.

## Local run

```bash
pip install -r requirements.txt
uvicorn render_app:app --host 127.0.0.1 --port 8000
```

Open `http://localhost:8000/` for the original AGULA Terminal and `http://localhost:8000/algo` for the new dashboard. `GET /api/algo/info` documents paper capabilities. `GET /api/algo/signal?symbol=SPY&fast=20&slow=50` generates a research signal.

## Render deployment

1. Upload or commit the overlay files into the main branch of the existing GitHub repo (do **not** upload just this overlay as a standalone Render project).
2. In Render, create or update the Blueprint for that repository. The root `render.yaml` already contains the new start command.
3. Optional: set `AGULA_PAPER_TOKEN` as a long random secret (24+ characters) to allow **manual simulated fills** via `/algo`. Example generation: `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Without it, trade writes return HTTP 503.
4. Check `/health` (existing terminal), `/algo`, and `/api/algo/info` after deployment.

**Critical storage limitation:** Render's free filesystem is ephemeral. SQLite history at `/tmp/agula-paper` may disappear on restart or redeploy. Use the dashboard for research/demo purposes, not long-running portfolio accounting. Reliable state requires a paid persistent disk or managed database plus redesigned persistence/concurrency.

**No automation:** the paper bot runs only when a user manually calls the paper endpoint or CLI. No live broker connectivity, scheduler, broker reconciliation, market order validation or production authentication system is included.

## Security notes

Never commit `AGULA_PAPER_TOKEN` to GitHub. Treat the paper API as experimental; use a dedicated owner-only deployment for mutation endpoints. CORS and network exposure remain determined by the original AGULA app. For multiuser or real-money use, replace the static token with proper login, authorization, CSRF safeguards, audit logs, orders ledger, fresh broker data and broker-side safety controls.

## Folder layout

```
existing-agula-repository/
├─ agula.py                 # ORIGINAL FILE -- keep it
├─ requirements.txt         # ORIGINAL FILE -- keep it
├─ trading/paper_bot.py     # ORIGINAL FILE -- keep it
├─ render_app.py            # NEW wrapper
├─ render.yaml              # REPLACE old Render blueprint
├─ Procfile                 # REPLACE old Procfile
└─ render/
   ├─ __init__.py
   ├─ trading_api.py
   ├─ algo.html
   └─ README.md
```
