"""Baseline: fixed sample projects and their verified outputs ("the numbers are sacred").

Only offline calculations are used (no PVGIS, no internet), so results are reproducible.
`python -m tests.baseline.run` prints the current outputs; `--write` saves them as the new
expected.json. Rewrite expected.json ONLY for a change the owner decided, and note it in the
changelog and HANDOFF.md.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi.encoders import jsonable_encoder

from backend import energy, finance, shading
from backend.electrical import Module, design
from backend.layout import LayoutParams, compute_layout

HERE = Path(__file__).resolve().parent
PROJECTS = HERE / "projects.json"
EXPECTED = HERE / "expected.json"


def run_project(p: dict) -> dict:
    lay = compute_layout(p["area"], LayoutParams(keepouts=p["keepouts"], **p["layout"]))
    sh = shading.analyze(lay["panels"], p["obstacles"], p["layout"]["tilt_deg"],
                         p["layout"]["azimuth_deg"], p["layout"]["mounting"])
    en = energy.offline_estimate(p["lat"], p["lon"], lay["kwp"], p["layout"]["tilt_deg"],
                                 p["layout"]["azimuth_deg"], p["loss_pct"])
    el = design(Module(**p["module"]), lay["count"])
    fi = finance.analyse(finance.FinanceParams(kwp=lay["kwp"], annual_kwh=en["annual_kwh"], **p["finance"]))
    lay = {k: v for k, v in lay.items() if k != "panels"}  # panel corners are covered by count/area
    return jsonable_encoder({"layout": lay, "shading": sh, "energy": en, "electrical": el, "finance": fi})


def run_all() -> dict:
    return {p["name"]: run_project(p) for p in json.loads(PROJECTS.read_text(encoding="utf-8"))}


if __name__ == "__main__":
    out = run_all()
    if "--write" in sys.argv:
        EXPECTED.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        print(f"wrote {EXPECTED}")
    else:
        print(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True))
