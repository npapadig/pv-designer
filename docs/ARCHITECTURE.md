# Architecture and features (living document, update when they change)

PV Designer: a HelioScope-like PV design and yield tool. Runs locally on the owner's Windows PC
(`start_windows.bat` → http://127.0.0.1:8000). Owner: Νίκος, Greek-speaking, not technical.
Repo: github.com/npapadig/pv-designer, single `main` branch, several Claude threads push to it.

## Features (user flow = the 7 steps on the left rail)
1. **Έργο**: save/load/delete projects (JSON in `data/projects/`), PDF report download.
2. **Χώρος**: address search (Nominatim), draw panel areas and keep-outs/obstacles (with heights) on the map.
   Base maps: Esri World Imagery (default), Esri Clarity, Κτηματολόγιο orthophotos (WMS, 2007-09), OSM streets,
   and Google satellite once the owner saves an API key (then it becomes the default).
3. **Πάνελ**: module presets (with electrical values), tilt, azimuth (+ auto-align to longest edge), portrait/landscape,
   flush vs rack, setbacks, gaps; auto row spacing for racks (winter-solstice noon).
4. **Σκιές**: obstacle prisms + row-to-row shading, monthly shading %, shadows on the map at a chosen time.
5. **Inverter**: inverter library + custom, string sizing by temperature-corrected voltages, DC/AC ratio.
6. **Παραγωγή**: PVGIS PVcalc (fallback: offline pvlib clear-sky) and a detailed hourly pvlib simulation from
   PVGIS TMY (cached in `data/weather/`) with a loss breakdown.
7. **Οικονομικά**: self-consumption / net billing / net metering, payback, ROI, NPV, IRR, LCOE, 25-year cash flow.

## Architecture
- Backend: FastAPI (`backend/main.py` holds all routes and request models). One module per domain:
  `layout.py` (shapely/pyproj grid fill), `energy.py` (PVGIS + fallback), `simulation.py` (pvlib hourly),
  `shading.py`, `electrical.py` + `equipment.py`, `finance.py`, `report.py` + `mapimage.py` (reportlab PDF,
  fonts in `backend/fonts/`), `storage.py` (projects), `settings.py` (`data/settings.json`, Google key).
- Frontend: plain HTML/JS, no build step. `frontend/app.js` (map, layers, steps logic, API calls),
  `electrical.js` (inverter/simulation UI), `ui.js` (look: rail, panel, dock, theme), `nudge.js` (move all drawings
  by metres to match offset imagery; uses app.js globals).
- Roof faces (v0.6, backend only so far): `/api/layout/faces`, and optional `faces` / `panel_face` on
  `/api/shading`, `/api/shadows`, `/api/energy`, `/api/simulate` (details in `docs/streams/faces.md`). Libraries vendored in
  `frontend/vendor/` (Leaflet 1.9.4, Leaflet.draw 1.0.4, Chart.js 4.4.1, Inter font).
- Data that must survive updates lives in `data/` (git-ignored, excluded by the updater).
- Version: `VERSION` → `GET /api/version` → header badge and launcher console. `CHANGELOG.md` in Greek.
- Tests: `python -m pytest` (≈60 tests, all backend + API). No frontend tests; the container's Playwright
  Chromium (`/opt/pw-browsers/chromium`) works for smoke tests, but outbound map/PVGIS hosts are blocked there.

## Windows launcher (fragile area, read before touching)
- `start_windows.bat` runs `update.ps1` (compares latest `main` SHA with `.version`, downloads the ZIP, robocopies
  over the app except `.venv` and `data`, then the bat restarts itself), finds **Python 3.12** (installs it with
  `py install 3.12` if missing), creates/keeps `.venv`, `pip install -r requirements.txt` when `requirements.txt`
  changed, then runs uvicorn on port 8000.
- Keep CRLF (`.gitattributes` has `-text`), greeklish console text, no `if errorlevel` after Python Install Manager
  calls (negative exit codes), and never delete `.venv` when a reinstall suffices (OneDrive/AV file locks).
- The owner's folder was under OneDrive; the updater warns about it.

