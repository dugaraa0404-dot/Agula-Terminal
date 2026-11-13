#!/usr/bin/env bash
# Agula Terminal - first run installs packages, then opens http://localhost:8000
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
pip install -r requirements.txt
python agula.py
