"""App settings (e.g. the Google Maps key) kept in data/settings.json.

data/ is outside git and is never touched by the auto-updater, so settings
survive updates.

The mobile-app fields (password hash, tokens) live in the same file but are NOT part of
`load()` / `save()`, which feed GET/PUT /api/settings: they must never reach a page.
"""
from __future__ import annotations

import json
from pathlib import Path

SETTINGS_FILE = Path(__file__).resolve().parent.parent / "data" / "settings.json"
DEFAULTS = {"google_maps_key": ""}
MOBILE_DEFAULTS = {"mobile_enabled": False, "mobile_password_hash": "", "mobile_tokens": {}}


def _read() -> dict:
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load() -> dict:
    data = _read()
    return {k: data.get(k, v) for k, v in DEFAULTS.items()}


def save(changes: dict) -> dict:
    data = _read()
    data.update({k: v for k, v in changes.items() if k in DEFAULTS})
    _write(data)
    return load()


def load_mobile() -> dict:
    data = _read()
    return {k: data.get(k, v) for k, v in MOBILE_DEFAULTS.items()}


def save_mobile(changes: dict) -> dict:
    data = _read()
    data.update({k: v for k, v in changes.items() if k in MOBILE_DEFAULTS})
    _write(data)
    return load_mobile()
