# Architecture and features (living document, update when they change)

PV Designer: a HelioScope-like PV design and yield tool. Runs locally on the owner's Windows PC
(`start_windows.bat` → http://127.0.0.1:8000). Owner: Νίκος, Greek-speaking, not technical.
Repo: github.com/npapadig/pv-designer, single `main` branch, several Claude threads push to it.

## Features (user flow = the 7 steps on the left rail)
1. **Έργο**: save/load/delete projects (JSON in `data/projects/`), PDF report download.
2. **Χώρος**: address search (suggestions while typing from Photon in `search.js`; the button uses Nominatim),
   draw panel areas and keep-outs/obstacles (with heights) on the map.
   Base maps: Esri World Imagery (default), Esri Clarity, Κτηματολόγιο orthophotos (WMS, 2007-09), OSM streets,
   and Google satellite with a saved API key (then it opens by itself as the default; without a working key the map
   menu shows a small «Κλειδί Google…» entry).
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
- v0.9: `home.js`/`home.css` (start screen, project cards), `plan.js` (floor-plan image on the map; images in
  `data/plans/` via `POST/GET /api/plans`), `draw.js`/`draw.css` (side lengths, styles, edit mode, compass),
  `options.js`/`options.css` + `layout.layout_options` / `POST /api/layout/options` / `/api/layout/ew` (3 proposals +
  manual; tilts in `OPTION_*` constants), `appendix_i.py` + `POST /api/appendix-i` (DEDDIE Παράρτημα Ι pre-filled, Greek only, v0.16); `tech_description.py` + `POST /api/tech-description` (button «Τεχνική περιγραφή PDF», v0.15); `single_line.py` + `POST /api/single-line` (button «Μονογραμμικό PDF», v0.14: single-line diagram from `project.electrical.design`, indicative protections); `plan_drawing.py` + `POST /api/plan-drawing` (button «Κάτοψη PDF», v0.13): clean to-scale vector floor plan (A4/A3) for permit applications; `mapimage.py` uses the on-screen base map (`basemap` sent by the app).
- Start of a project (stream arxi, 2026-10-22): the start screen asks existing building / new building / park on a
  field (`project_type`: existing/new/park), then for a building flat or pitched roof (`roof_type`: flat/pitched;
  flat hides `#facesBox` and picks racks). A new building is first placed (search or map click, `plan.askWhere`),
  then the floor plan is offered at that spot. Older projects: type "new" if they have a plan, roof "pitched" if
  they have faces.
- Roof faces (v0.6-0.8): `frontend/faces.js` (split a roof along a line via `/api/split`, per-face tilt/azimuth);
  `/api/layout/faces`, and optional `faces` / `panel_face` on `/api/shading`, `/api/shadows`, `/api/energy`,
  `/api/simulate`, `/api/electrical` (strings per face → own MPPT, optional mixing). Details: `docs/streams/faces.md`. Libraries vendored in
  `frontend/vendor/` (Leaflet 1.9.4, Leaflet.draw 1.0.4, Chart.js 4.4.1, Inter font).
- Data that must survive updates lives in `data/` (git-ignored, excluded by the updater).
- Version: `VERSION` → `GET /api/version` → header badge and launcher console. `CHANGELOG.md` in Greek.
- Tests: `python -m pytest` (≈60 tests, all backend + API). No frontend tests; the container's Playwright
  Chromium (`/opt/pw-browsers/chromium`) works for smoke tests, but outbound map/PVGIS hosts are blocked there.

## Windows launcher (fragile area, read before touching)
- `start_windows.bat` runs `update.ps1` (compares latest `main` SHA with `.version`, downloads the ZIP, robocopies
  over the app except `.venv` and `data`, then the bat restarts itself), finds **Python 3.12** (installs it with
  `py install 3.12` if missing), creates/keeps `.venv`, `pip install -r requirements.txt` when `requirements.txt`
  changed, then starts `pythonw -m backend.lifecycle` (no console window) and closes itself once the server
  answers on port 8000; if the app already answers there, it only opens the browser (no update check).
- `backend/lifecycle.py`: starts uvicorn, opens the browser only when `/api/health` answers, and stops the server
  when the browser is closed. Every page (`home.js`) POSTs `/api/lifecycle/hello`, `ping` every 30 s and `bye`
  (sendBeacon on `pagehide`); stop ~10 s after a bye with no page left, or after 3 min without news (hidden tabs,
  crashes); sleep of the PC restarts the timers. Only the launcher arms the stop (tests / plain uvicorn never stop).
  With pythonw the server log is `%TEMP%\pv-designer-server.log`; a failed start shows a Windows message box.
  `PV_DESIGNER_PORT` changes the port for tests. `update.ps1` also stops a running `backend.lifecycle`.
  `start_mac_linux.sh` runs the same module (with its terminal).
- Keep CRLF (`.gitattributes` has `-text`), greeklish console text, no `if errorlevel` after Python Install Manager
  calls (negative exit codes), and never delete `.venv` when a reinstall suffices (OneDrive/AV file locks).
- The owner's folder was under OneDrive; the updater warns about it.

