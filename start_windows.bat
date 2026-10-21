@echo off
setlocal
cd /d "%~dp0"
echo === PV Designer ===
echo.

rem Fetch the latest version from GitHub. If files were replaced (this script
rem included), restart from the new copy; the whole line is parsed before it runs.
if exist .updated del .updated
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" & if exist "%~dp0.updated" (del "%~dp0.updated" & "%~f0" & exit /b)
echo.

rem The app needs Python 3.12: newer versions (3.13+) lack ready-made packages
rem for some libraries, and pip then tries to compile them and fails.
set "PY="
call :find_python
if defined PY goto have_python

echo Den brethhke Python 3.12. Ginetai egkatastash tou twra...
where py >nul 2>nul
if errorlevel 1 goto no_python
echo (an sas rwthsei kati, grapste Y kai patiste Enter)
py install 3.12
call :find_python
if defined PY goto have_python

:no_python
echo.
echo Den brethhke Python 3.12.
echo Katebase to "Windows installer (64-bit)" apo:
echo     https://www.python.org/downloads/release/python-31210/
echo kai tsekare to "Add python.exe to PATH" kata thn egkatastash.
echo Meta trexe xana ayto to arxeio.
pause
exit /b 1

:have_python
echo Xrhsimopoieitai: %PY%

rem Remove an environment left half-finished or made with another Python version.
if exist .venv\ready-312.txt goto run
if exist .venv (
  echo Katharismos palioy periballontos...
  rmdir /s /q .venv
)
echo Prwth fora: dhmiourgia periballontos Python...
%PY% -m venv .venv
if not exist .venv\Scripts\python.exe goto install_failed
echo Egkatastash bibliothikwn (thn prwth fora pairnei 1-3 lepta)...
.venv\Scripts\python -m pip install --quiet --upgrade pip
.venv\Scripts\python -m pip install --prefer-binary -r requirements.txt
if not "%errorlevel%"=="0" goto install_failed
echo ok> .venv\ready-312.txt

:run
echo.
echo H efarmogh trexei sto http://127.0.0.1:8000
echo Gia na th stamathseis, kleise ayto to parathyro.
start "" http://127.0.0.1:8000
.venv\Scripts\python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
pause
exit /b 0

:install_failed
echo.
echo Apetyxe h egkatastash bibliothikwn. Kane screenshot ayto to parathyro
echo kai steile to sto Claude.
if exist .venv rmdir /s /q .venv
pause
exit /b 1

:find_python
rem Only trust a candidate if it really runs and prints 3.12; error codes from
rem the Python Install Manager can be negative and slip past "if errorlevel".
call :try_python py -V:3.12
if defined PY exit /b 0
call :try_python py -3.12
if defined PY exit /b 0
call :try_python python
exit /b 0

:try_python
set "VER="
for /f "delims=" %%v in ('%* -c "import sys; print(*sys.version_info[:2], sep=chr(46))" 2^>nul') do set "VER=%%v"
if "%VER%"=="3.12" set "PY=%*"
exit /b 0
