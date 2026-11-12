@echo off
REM Agula Terminal - first run installs packages, then opens http://localhost:8000
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv || python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
pip install -r requirements.txt
python agula.py
pause
