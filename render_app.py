"""AGULA: existing research terminal + opt-in local simulated paper dashboard.

Requires the ORIGINAL AGULA repository's `agula.py` and `trading/paper_bot.py`.
Does not contact brokerage trading endpoints.
"""
from agula import app  # preserve existing terminal and APIs
from render.trading_api import router

app.include_router(router)
