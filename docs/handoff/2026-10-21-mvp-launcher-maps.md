# MVP, launcher and base maps (v0.1.0 – v0.5.1, 2026-10-21)

## What changed
- MVP: map drawing, `layout.py` grid fill, `energy.py` PVGIS + offline fallback, projects, print report.
- Windows launcher: Python 3.12 pinning (3.15 had no wheels → h5py source build failed), robust detection,
  self-update from GitHub (`update.ps1`), stop a running instance, keep `.venv`, OneDrive warning.
- Versioning: `VERSION`, `/api/version`, header badge, `CHANGELOG.md`, CLAUDE.md rules.
- Maps: Esri adaptive max native zoom via the tilemap service, Esri Clarity, Κτηματολόγιο WMS, Google Map Tiles
  with the owner's key (`backend/settings.py`, `/api/settings`, "Χάρτης Google" box in step Χώρος).
- `docs/handoff/` with this note and the app overview; CLAUDE.md rule to read/write handoff notes.

## Decisions and why
- Vendored JS libraries: CDNs were unreachable from the container and it removes a runtime dependency.
- Greeklish in cmd output: Greek is garbled in cmd.exe.
- Google tiles go browser → Google directly with the owner's key (local app, single user). If the app is hosted,
  move tile session creation server-side and restrict the key by referrer.

## Known issues / not verified
- No Windows machine here: every `.bat`/`.ps1` change was only reviewed, not executed.
- Κτηματολόγιο and Google layers are not verified against the real services (see overview).

## Next steps
- Confirm with the owner that Google and Κτηματολόγιο layers show imagery.
- Owner prefers multiple-choice questions; in chat use numbered options (no checkbox cards available).
