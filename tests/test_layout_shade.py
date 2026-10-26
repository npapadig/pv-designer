"""Placement option «αποφυγή σκιασμένων θέσεων» (stream topothetisi): shaded positions are left empty."""
from fastapi.testclient import TestClient

from backend.layout import LayoutParams, compute_layout, remove_shaded
from backend.main import app
from tests.test_layout import square
from tests.test_shading import rect

client = TestClient(app)
AREA = square(12, 6)
TALL = {"polygon": rect(-2, -6, 2, -4), "height_m": 5}  # tall block just south of the roof


def _body(**extra):
    return {"area": AREA, "tilt_deg": 30, "mounting": "flush", "obstacles": [TALL], **extra}


def test_off_by_default():
    a = client.post("/api/layout", json=_body()).json()
    b = client.post("/api/layout", json=_body(avoid_shaded=False)).json()
    assert a["count"] == b["count"] == compute_layout(AREA, LayoutParams(tilt_deg=30))["count"]
    assert "removed_shaded" not in a


def test_shaded_panels_are_dropped_and_limit_matters():
    full = client.post("/api/layout", json=_body()).json()
    strict = client.post("/api/layout", json=_body(avoid_shaded=True, max_shade_pct=1)).json()
    loose = client.post("/api/layout", json=_body(avoid_shaded=True, max_shade_pct=100)).json()
    assert loose["count"] == full["count"] and loose["removed_shaded"] == 0
    assert strict["count"] < full["count"]
    assert strict["count"] + strict["removed_shaded"] == full["count"]
    assert len(strict["panels"]) == strict["count"]
    assert strict["kwp"] == round(strict["count"] * 0.41, 3)


def test_without_obstacle_height_nothing_is_dropped():
    flat_obstacle = {**TALL, "height_m": 0}
    res = client.post("/api/layout", json=_body(obstacles=[flat_obstacle], avoid_shaded=True, max_shade_pct=0)).json()
    assert res["removed_shaded"] == 0


def test_remove_shaded_keeps_faces_in_step():
    lay = compute_layout(AREA, LayoutParams(tilt_deg=30))
    n = lay["count"]
    lay["faces"] = [{"tilt_deg": 30, "azimuth_deg": 180, "count": n, "kwp": 0}]
    lay["panel_face"] = [0] * n
    out = remove_shaded(lay, [TALL], 30, 180, "flush", 1, 410, 1.953)
    assert out["faces"][0]["count"] == out["count"] == len(out["panel_face"]) < n
