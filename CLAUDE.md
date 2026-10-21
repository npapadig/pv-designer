# PV Designer: rules for contributors

- The app owner is Greek-speaking and not technical. All user-facing text (UI, launcher messages, README, CHANGELOG) is in Greek; launcher console messages are in greeklish because cmd.exe mangles Greek.
- **Every change merged to `main` must bump the version** in `VERSION` (semver: patch for fixes, minor for new features) **and add an entry at the top of `CHANGELOG.md`** (in Greek, one line per change, under a `## vX.Y.Z (date)` heading). Several threads push to `main` in parallel: before merging, rebase on `main` and re-check that your version is higher than the one there, renumbering your entry if needed.
- The version is shown in the app header (from `GET /api/version`) and in the `start_windows.bat` console; `update.ps1` prints "apo vX se vY" after updating. Do not hardcode the version anywhere else.
- Windows launcher (`start_windows.bat`, `update.ps1`) must keep CRLF line endings and must not rely on `if errorlevel` for the Python Install Manager (it can return negative codes).
- Run the tests with `python -m pytest` before pushing.
