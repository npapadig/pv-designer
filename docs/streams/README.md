# Streams

A stream is a small, independent piece of work run in its own session and git worktree/branch.
The coordinator (main session, `main` branch) writes `docs/streams/<name>.md` before starting it, with:
goal, files it owns, numbered items, checks to run, and a status table. Max 2 streams at a time.

| Stream | Task file | Owns (files) | Status |
|---|---|---|---|
| nudge | `nudge.md` | `frontend/nudge.js`, λίγες γραμμές σε `index.html`/`style.css`/`app.js` (χάρτης) | ξεκίνησε 2026-10-21 |
| faces | `faces.md` | engine + `backend/main.py` + υπόλοιπο `frontend/app.js`, `electrical.js` | ξεκίνησε 2026-10-21 |

Suggested split by area (owned files), so streams do not collide:
- **maps**: map layers and drawing in `frontend/app.js` (map section), `backend/settings.py`.
- **engine**: `backend/layout.py`, `energy.py`, `simulation.py`, `shading.py`, `electrical.py`, `finance.py` + their tests.
- **report**: `backend/report.py`, `backend/mapimage.py`.
- **look**: `frontend/ui.js`, `frontend/style.css`, `frontend/index.html` (layout only).
- **launcher**: `start_windows.bat`, `update.ps1`, `requirements.txt` (CRLF!).
Shared files (`backend/main.py`, `VERSION`, `CHANGELOG.md`, `HANDOFF.md`) are changed only by the coordinator.
