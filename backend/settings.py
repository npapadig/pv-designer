"""App settings (e.g. the Google Maps key) kept in data/settings.json.

data/ is outside git and is never touched by the auto-updater, so settings
survive updates.
"""
from __future__ import annotations

import json
from pathlib import Path

SETTINGS_FILE = Path(__file__).resolve().parent.parent / "data" / "settings.json"
DEFAULTS = {"google_maps_key": ""}


def load() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    return {k: data.get(k, v) for k, v in DEFAULTS.items()}


def save(changes: dict) -> dict:
    data = load()
    data.update({k: v for k, v in changes.items() if k in DEFAULTS})
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data
