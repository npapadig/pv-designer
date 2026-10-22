# Streams

A stream is a small, independent piece of work run in its own session and git worktree/branch.
The coordinator (main session, `main` branch) writes `docs/streams/<name>.md` before starting it, with:
goal, files it owns, numbered items, checks to run, and a status table. Max 2 streams at a time.

| Stream | Task file | Owns (files) | Status |
|---|---|---|---|
| nudge | `nudge.md` | `frontend/nudge.js`, λίγες γραμμές σε `index.html`/`style.css`/`app.js` (χάρτης) | ΤΕΛΟΣ (v0.6.0) |
| faces | `faces.md` | engine + `backend/main.py` + υπόλοιπο `frontend/app.js`, `electrical.js` | ΤΕΛΟΣ (v0.8.0) |
| home | `home.md` | `home.js`, `plan.js`, `home.css`, app.js «Projects», `storage.py` | ξεκίνησε 2026-10-22 |
| pdf | `pdf.md` | `mapimage.py`, εικόνα στο `report.py` | ξεκίνησε 2026-10-22 |
| draw | `draw.md` | `draw.js`, `draw.css`, app.js «Map» | σε αναμονή (2η σειρά) |
| options | `options.md` | προτάσεις διάταξης, app.js «Layout» | σε αναμονή (αποφάσεις Νίκου) |

Suggested split by area (owned files), so streams do not collide:
- **maps**: map layers and drawing in `frontend/app.js` (map section), `backend/settings.py`.
- **engine**: `backend/layout.py`, `energy.py`, `simulation.py`, `shading.py`, `electrical.py`, `finance.py` + their tests.
- **report**: `backend/report.py`, `backend/mapimage.py`.
- **look**: `frontend/ui.js`, `frontend/style.css`, `frontend/index.html` (layout only).
- **launcher**: `start_windows.bat`, `update.ps1`, `requirements.txt` (CRLF!).
Shared files (`backend/main.py`, `VERSION`, `CHANGELOG.md`, `HANDOFF.md`) are changed only by the coordinator.
