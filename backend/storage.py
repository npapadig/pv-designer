"""Projects are stored as one JSON file each under data/projects/."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "projects"
_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def _path(project_id: str) -> Path:
    if not _ID_RE.match(project_id):
        raise KeyError(project_id)
    return DATA_DIR / f"{project_id}.json"


def list_projects() -> list[dict]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for f in DATA_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        layout, en = d.get("layout") or {}, d.get("energy") or {}
        items.append({
            "id": d["id"], "name": d.get("name", ""), "updated_at": d.get("updated_at", ""),
            # Shown on the cards of the start screen.
            "kwp": layout.get("kwp"), "annual_kwh": en.get("annual_kwh"),
            "address": (d.get("report_info") or {}).get("address", ""),
            "has_plan": bool((d.get("plan") or {}).get("image")),
        })
    return sorted(items, key=lambda x: x["updated_at"], reverse=True)


def get_project(project_id: str) -> dict:
    p = _path(project_id)
    if not p.exists():
        raise KeyError(project_id)
    return json.loads(p.read_text(encoding="utf-8"))


def save_project(data: dict, project_id: str | None = None) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    project_id = project_id or data.get("id") or uuid.uuid4().hex
    data = {**data, "id": project_id, "updated_at": datetime.now(timezone.utc).isoformat()}
    _path(project_id).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def delete_project(project_id: str) -> None:
    p = _path(project_id)
    if not p.exists():
        raise KeyError(project_id)
    p.unlink()
