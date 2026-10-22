@echo off
setlocal
cd /d "%~dp0"

rem Already running: just open the browser (updates wait for the next start).
curl.exe -s -m 2 http://127.0.0.1:8000/api/health 2>nul | findstr /r /c:"ok.:true" >nul
if not errorlevel 1 (
  start "" http://127.0.0.1:8000
  exit /b 0
)

rem Fetch the latest version from GitHub. If files were replaced (this script
rem included), restart from the new copy; the whole line is parsed before it runs.
if exist .updated del .updated
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" & if exist "%~dp0.updated" (del "%~dp0.updated" & "%~f0" & exit /b)
echo.
set "APPVER=?"
if exist VERSION set /p APPVER=<VERSION
title PV Designer v%APPVER%
echo === PV Designer v%APPVER% ===
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

if exist .venv\ready-312.txt goto run

rem Keep an existing 3.12 environment and just (re)install libraries into it:
rem deleting it fails when files are locked (OneDrive sync, antivirus).
set "VENV_OK="
if exist .venv\Scripts\python.exe for /f "delims=" %%v in ('.venv\Scripts\python.exe -c "import sys; print(*sys.version_info[:2], sep=chr(46))" 2^>nul') do if "%%v"=="3.12" set "VENV_OK=1"
if defined VENV_OK goto install_libs

if exist .venv (
  echo Katharismos palioy periballontos...
  rmdir /s /q .venv
)
if exist .venv goto venv_locked
echo Prwth fora: dhmiourgia periballontos Python...
%PY% -m venv .venv
if not exist .venv\Scripts\python.exe goto install_failed

:install_libs
echo Egkatastash bibliothikwn (thn prwth fora pairnei 1-3 lepta)...
.venv\Scripts\python -m pip install --quiet --upgrade pip
.venv\Scripts\python -m pip install --prefer-binary -r requirements.txt
if not "%errorlevel%"=="0" goto install_failed
echo ok> .venv\ready-312.txt

:run
echo.
echo Ksekinaei h efarmogh, se ligo anoigei o browser...
echo (Stamata monh ths otan kleiseis ton browser.)
rem backend\lifecycle.py runs the server without a window (pythonw), opens the browser once the
rem server answers and stops the server when the browser is closed.
if exist .venv\Scripts\pythonw.exe (
  start "" .venv\Scripts\pythonw.exe -m backend.lifecycle
) else (
  start "PV Designer" /min .venv\Scripts\python.exe -m backend.lifecycle
)
rem Keep this window (with the message above) until the server answers, then close it.
where curl.exe >nul 2>nul
if errorlevel 1 exit /b 0
for /l %%i in (1,1,60) do (
  curl.exe -s -m 1 http://127.0.0.1:8000/api/health 2>nul | findstr /r /c:"ok.:true" >nul && exit /b 0
  timeout /t 1 /nobreak >nul
)
exit /b 0

:install_failed
echo.
echo Apetyxe h egkatastash bibliothikwn. Kane screenshot ayto to parathyro
echo kai steile to sto Claude.
pause
exit /b 1

:venv_locked
echo.
echo Den htan dynato na sbhstei o fakelos .venv (kapoio arxeio einai kleidwmeno).
echo 1. Kleise ola ta parathyra ths efarmoghs kai ksanatrexe ayto to arxeio.
echo 2. An synexizei, kane epanekkinhsh ston ypologisth.
echo 3. An o fakelos einai mesa sto OneDrive, metefere ton sto C:\pv-designer
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
