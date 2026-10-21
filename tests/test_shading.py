from fastapi.testclient import TestClient
from pyproj import Transformer

from backend import energy, shading
from backend.layout import LayoutParams, compute_layout
from backend.main import app
from tests.test_layout import LAT0, LON0, square


def rect(x0, y0, x1, y1):
    """Rectangle given in metres east/north of the test centre, as [[lat, lng], ...]."""
    proj = f"+proj=aeqd +lat_0={LAT0} +lon_0={LON0} +datum=WGS84 +units=m"
    inv = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [[lat, lng] for lng, lat in (inv.transform(x, y) for x, y in pts)]


def flush_panels():
    return compute_layout(square(10, 6), LayoutParams(tilt_deg=30))["panels"]


def test_no_obstacles_no_shading_on_flush_roof():
    res = shading.analyze(flush_panels(), [], 30, 180, "flush")
    assert res["annual_loss_pct"] == 0
    assert not res["row_shading"]


def test_zero_height_obstacle_casts_no_shadow():
    res = shading.analyze(flush_panels(), [{"polygon": rect(-1, -6, 1, -4), "height_m": 0}], 30, 180, "flush")
    assert res["annual_loss_pct"] == 0


def test_obstacle_south_shades_more_than_north():
    south = shading.analyze(flush_panels(), [{"polygon": rect(-2, -7, 2, -5), "height_m": 4}], 30, 180, "flush")
    north = shading.analyze(flush_panels(), [{"polygon": rect(-2, 5, 2, 7), "height_m": 4}], 30, 180, "flush")
    assert south["annual_loss_pct"] > north["annual_loss_pct"] > 0
    assert south["beam_loss_pct"] > 1
    # Winter sun is low, so winter months lose more than summer ones.
    m = south["monthly_loss_pct"]
    assert m[11] > m[5]
    assert len(south["panel_loss_pct"]) == len(flush_panels())


def test_tight_rack_rows_shade_more_than_automatic_spacing():
    auto = compute_layout(square(20, 12), LayoutParams(mounting="rack", tilt_deg=30))
    tight = compute_layout(square(20, 12), LayoutParams(mounting="rack", tilt_deg=30, row_spacing_m=0.3))
    a = shading.analyze(auto["panels"], [], 30, 180, "rack")
    t = shading.analyze(tight["panels"], [], 30, 180, "rack")
    assert a["row_shading"] and t["row_shading"]
    assert t["beam_loss_pct"] > a["beam_loss_pct"] + 2
    assert a["beam_loss_pct"] < 1.5  # the automatic gap is sized to avoid winter-noon shade


def test_apply_shading_reduces_production():
    base = {"annual_kwh": 1200.0, "specific_yield": 1200, "monthly": [{"month": m, "kwh": 100.0} for m in range(1, 13)]}
    res = energy.apply_shading(base, [10.0] * 6 + [0.0] * 6, 1.0)
    assert res["annual_kwh"] == 1140
    assert res["annual_kwh_unshaded"] == 1200
    assert res["shading_loss_pct"] == 5.0
    assert res["monthly"][0]["kwh"] == 90 and res["monthly"][0]["kwh_unshaded"] == 100


def test_shading_and_shadow_endpoints():
    client = TestClient(app)
    body = {"panels": flush_panels(), "obstacles": [{"polygon": rect(-2, -7, 2, -5), "height_m": 4}],
            "tilt_deg": 30, "azimuth_deg": 180, "mounting": "flush"}
    r = client.post("/api/shading", json=body)
    assert r.status_code == 200 and r.json()["annual_loss_pct"] > 0
    r = client.post("/api/shadows", json={**body, "when": "2025-12-21T10:00:00Z"})
    assert r.status_code == 200
    assert r.json()["sun_elevation"] > 20 and r.json()["shadows"]
    r = client.post("/api/shadows", json={**body, "when": "2025-12-21T22:00:00Z"})
    assert r.json()["shadows"] == []
    assert client.post("/api/shading", json={**body, "panels": []}).status_code == 400


def test_shading_appears_in_pdf_report():
    from backend import report
    res = shading.analyze(flush_panels(), [{"polygon": rect(-2, -7, 2, -5), "height_m": 4}], 30, 180, "flush")
    assert res["report"]["summary"][0][1].endswith("%")
    pdf = report.build_pdf({"name": "Δοκιμή", "shading": res, "layout": {"kwp": 5, "count": 12}}, imagery=False)
    assert pdf[:4] == b"%PDF"
