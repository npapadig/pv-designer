#!/usr/bin/env bash
# PV Designer: creates a Python environment on first run, then starts the app.
set -e
cd "$(dirname "$0")"
# Python 3.12 is preferred: newer versions may lack ready-made packages for some libraries.
PY=$(command -v python3.12 || command -v python3 || true)
[ -n "$PY" ] || { echo "Δεν βρέθηκε Python 3.12. Εγκατάστησέ το από https://www.python.org/downloads/release/python-31210/"; exit 1; }
if [ ! -d .venv ]; then
  echo "Πρώτη φορά: δημιουργία περιβάλλοντος Python..."
  $PY -m venv .venv
fi
echo "Έλεγχος βιβλιοθηκών (την πρώτη φορά παίρνει 1-2 λεπτά)..."
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet --prefer-binary -r requirements.txt
echo "Η εφαρμογή τρέχει στο http://127.0.0.1:8000  (Ctrl+C για τερματισμό)"
( sleep 2; (open http://127.0.0.1:8000 || xdg-open http://127.0.0.1:8000) >/dev/null 2>&1 ) &
exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
