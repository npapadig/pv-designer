@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === PV Designer ===
where py >nul 2>nul
if %errorlevel%==0 (set PY=py -3) else (set PY=python)
if not exist .venv (
  echo Prwth fora: dhmiourgia periballontos Python...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo.
    echo Den brethhke Python. Egkatasthse to apo https://www.python.org/downloads/
    echo kai tsekare to "Add python.exe to PATH" kata thn egkatastash.
    pause
    exit /b 1
  )
)
echo Elegxos bibliothikwn (thn prwth fora pairnei 1-2 lepta)...
.venv\Scripts\python -m pip install --quiet --upgrade pip
.venv\Scripts\python -m pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo Apetyxe h egkatastash bibliothikwn. Elegxe th syndesh sto internet.
  pause
  exit /b 1
)
echo.
echo H efarmogh trexei sto http://127.0.0.1:8000
echo Gia na th stamathseis, kleise ayto to parathyro.
start "" http://127.0.0.1:8000
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
pause
