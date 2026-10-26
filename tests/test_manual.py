"""Check of a hand-edited layout against the placement rules (stream xeirokiniti)."""
from fastapi.testclient import TestClient

from backend.layout import LayoutParams, compute_faces_layout, compute_layout
from backend.main import app
from backend.manual import check_layout
from tests.test_layout import square
from tests.test_shading import rect

BASE = dict(panel_width_m=1.0, panel_length_m=2.0, tilt_deg=0, col_spacing_m=0.02, row_spacing_m=0.02,
            setback_m=0.5, mounting="rack")
AREA = square(10, 10)
client = TestClient(app)


def check(panels, **kw):
    return check_layout(panels, kw.pop("areas", [AREA]), LayoutParams(**{**BASE, **kw.pop("p", {})}), **kw)


def reasons(res):
    return {v["index"]: v["reasons"] for v in res["violations"]}


def test_automatic_layout_has_no_violations():
    p = LayoutParams(**BASE, keepouts=[rect(-1, -1, 1, 1)], obstacle_gap_m=0.7)
    lay = compute_layout(AREA, p)
    assert lay["count"] > 10
    res = check_layout(lay["panels"], [AREA], p)
    assert res["count_bad"] == 0 and res["area_of"] == [0] * lay["count"]


def test_each_rule_is_named():
    ok = rect(-4, -4, -3, -2)                 # inside, 1 m from the outline
    outside = rect(5.5, 0, 6.5, 2)            # outside the area
    edge = rect(3.8, 0, 4.8, 2)               # inside, 0.2 m from the outline (< 0.5)
    ontop = rect(-1, -1, 0, 1)                # on the obstacle
    overlap_a, overlap_b = rect(0, 3, 1, 4), rect(0.5, 3.5, 1.5, 4.5)
    res = check([ok, outside, edge, ontop, overlap_a, overlap_b], p={"keepouts": [rect(-2, -1.5, 0.5, 1.5)]})
    r = reasons(res)
    assert 0 not in r
    assert r[1] == ["outside"]
    assert r[2] == ["edge"]
    assert r[3] == ["obstacle"]
    assert r[4] == ["overlap"] and r[5] == ["overlap"]
    assert res["by_reason"] == {"outside": 1, "edge": 1, "obstacle": 1, "overlap": 2}
    assert res["area_of"][1] == -1 or res["area_of"][1] == 0


def test_touching_panels_are_not_an_overlap():
    assert check([rect(0, 0, 1, 2), rect(1, 0, 2, 2)])["count_bad"] == 0


def test_obstacle_gap_is_used():
    near = rect(0.2, -1, 1.2, 1)               # 0.2 m from the obstacle
    ko = [rect(-2, -1, 0, 1)]
    assert check([near], p={"keepouts": ko, "obstacle_gap_m": 0})["count_bad"] == 0
    assert reasons(check([near], p={"keepouts": ko, "obstacle_gap_m": 0.5})) == {0: ["obstacle"]}


def test_ridge_gap_between_faces():
    left, right = rect(-5, -5, 0, 5), rect(0, -5, 5, 5)
    near_ridge = rect(-1.2, 0, -0.2, 2)        # 0.2 m from the shared edge, far from the other edges
    kw = dict(areas=[left, right], use_ridge=True, p={"setback_m": 0.1, "ridge_gap_m": 0.6})
    assert reasons(check([near_ridge], **kw)) == {0: ["ridge"]}
    assert check([rect(-2.5, 0, -1.5, 2)], **kw)["count_bad"] == 0
    # a panel of the second face is attributed to it
    assert check([rect(1.5, 0, 2.5, 2)], **kw)["area_of"] == [1]
    # without faces there is no ridge
    assert check([near_ridge], areas=[left, right], p={"setback_m": 0.1, "ridge_gap_m": 0.6})["count_bad"] == 0


def test_faces_layout_is_clean():
    faces = [{"area": rect(-5, -5, 0, 5), "tilt_deg": 0, "azimuth_deg": 180},
             {"area": rect(0, -5, 5, 5), "tilt_deg": 0, "azimuth_deg": 180}]
    p = LayoutParams(**{**BASE, "ridge_gap_m": 0.3})
    lay = compute_faces_layout(faces, p)
    res = check_layout(lay["panels"], [f["area"] for f in faces], p, use_ridge=True)
    assert res["count_bad"] == 0
    assert res["area_of"] == lay["panel_face"]


def test_shade_limit():
    tall = {"polygon": rect(-1, 1, 1, 3), "height_m": 20}
    panels = [rect(-1, -3, 0, -1), rect(2, 2, 3, 4)]
    res = check(panels, check_shade=True, max_shade_pct=1, obstacles=[tall], mounting="flush", azimuth_deg=180)
    flagged = reasons(res)
    assert flagged.get(0) == ["shade"] or flagged.get(1) == ["shade"]
    # off, or without obstacle heights: nothing is flagged for shade
    assert "shade" not in check(panels, obstacles=[tall])["by_reason"]
    assert check(panels, check_shade=True, obstacles=[{"polygon": tall["polygon"], "height_m": 0}])["count_bad"] == 0


def test_endpoint():
    body = {"panels": [rect(-4, -4, -3, -2), rect(5.5, 0, 6.5, 2)], "areas": [AREA], "setback_m": 0.5}
    r = client.post("/api/layout/check", json=body)
    assert r.status_code == 200
    assert r.json()["by_reason"] == {"outside": 1}
    assert client.post("/api/layout/check", json={**body, "areas": []}).status_code == 422
    assert client.post("/api/layout/check", json={**body, "panels": []}).json()["count_bad"] == 0
