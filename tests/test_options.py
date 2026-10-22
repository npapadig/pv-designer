"""Three ready-made layout proposals: economic (south), maximum energy (east-west), aesthetic (along the wall)."""
import math

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pyproj import Transformer

from backend import layout, mapimage, report
from backend.layout import LayoutParams, auto_row_gap, compute_ew_layout, compute_layout, layout_options, wall_azimuth
from backend.main import app
from tests.test_layout import LAT0, LON0
from tests.test_shading import rect

client = TestClient(app)
ROOF = rect(-8, -5, 8, 5)  # flat roof 16 x 10 m


def rotated_rect(w, h, deg):
    """w x h metres, turned deg degrees clockwise (compass), as [[lat, lng], ...]."""
    proj = f"+proj=aeqd +lat_0={LAT0} +lon_0={LON0} +datum=WGS84 +units=m"
    inv = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    a = math.radians(deg)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    pts = [(x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a)) for x, y in pts]
    return [[lat, lng] for lng, lat in (inv.transform(x, y) for x, y in pts)]


def by_key():
    return {o["key"]: o for o in layout_options([ROOF], LayoutParams())}


def test_three_options_in_order():
    opts = layout_options([ROOF], LayoutParams())
    assert [o["key"] for o in opts] == ["economic", "east_west", "aesthetic", "manual"]
    assert all(o["count"] > 0 for o in opts)
    assert all(o["mounting"] == "rack" for o in opts[:3])


def test_economic_is_south_with_automatic_row_gap():
    o = by_key()["economic"]
    assert o["azimuth_deg"] == 180
    assert layout.OPTION_ECONOMIC["tilt_min_deg"] <= o["tilt_deg"] <= layout.OPTION_ECONOMIC["tilt_deg"]
    p = LayoutParams(tilt_deg=o["tilt_deg"], mounting="rack")
    assert o["row_gap_m"] == round(auto_row_gap(p.panel_length_m, p.tilt_deg, LAT0), 2)
    assert o["panels"] == compute_layout(ROOF, p)["panels"]


def test_east_west_fits_the_most_panels_on_two_faces():
    o = by_key()
    ew = o["east_west"]
    assert ew["count"] > o["economic"]["count"]
    assert [f["azimuth_deg"] for f in ew["faces"]] == [90, 270]
    assert sum(f["count"] for f in ew["faces"]) == ew["count"] == len(ew["panel_face"])
    assert abs(ew["faces"][0]["count"] - ew["faces"][1]["count"]) <= ew["count"] // 4
    assert ew["kwp"] == round(ew["count"] * 0.41, 3)


def test_east_west_rows_alternate():
    res = compute_ew_layout(ROOF, LayoutParams(tilt_deg=10), 0.1)
    rows = {}  # rows run north-south, so the panels of a row share their longitude
    for panel, face in zip(res["panels"], res["panel_face"]):
        lng = round(sum(pt[1] for pt in panel) / 4, 6)
        rows.setdefault(lng, set()).add(face)
    faces = [rows[k] for k in sorted(rows)]  # west to east
    assert all(len(f) == 1 for f in faces)
    seq = [f.pop() for f in faces]
    assert seq[0] == 1  # the westernmost row faces west and leans against the next one
    assert all(a != b for a, b in zip(seq, seq[1:]))


def test_wall_azimuth_follows_the_building():
    assert wall_azimuth(ROOF) == 180
    assert wall_azimuth(rotated_rect(16, 10, 20)) == 200
    assert wall_azimuth(rotated_rect(16, 10, -25)) == 155
    o = layout_options([rotated_rect(16, 10, 20)], LayoutParams())[2]
    assert o["key"] == "aesthetic" and o["azimuth_deg"] == 200


def test_values_come_from_one_place(monkeypatch):
    monkeypatch.setitem(layout.OPTION_EAST_WEST, "tilt_deg", 15.0)
    monkeypatch.setitem(layout.OPTION_EAST_WEST, "tilt_min_deg", 15.0)
    monkeypatch.setitem(layout.OPTION_AESTHETIC, "tilt_deg", 5.0)
    monkeypatch.setitem(layout.OPTION_AESTHETIC, "tilt_min_deg", 5.0)
    o = by_key()
    assert all(f["tilt_deg"] == 15 for f in o["east_west"]["faces"])
    assert o["aesthetic"]["tilt_deg"] == 5


def test_several_areas_are_added_up():
    a, b = rect(-20, -5, -10, 5), rect(10, -5, 20, 5)
    one = {o["key"]: o["count"] for o in layout_options([a], LayoutParams())}
    two = {o["key"]: o for o in layout_options([a, b], LayoutParams())}
    assert all(two[k]["count"] == 2 * one[k] for k in one)
    assert len(two["east_west"]["panel_face"]) == two["east_west"]["count"]


def test_existing_layout_is_untouched():
    p = LayoutParams(tilt_deg=10, mounting="rack", azimuth_deg=90, row_spacing_m=0.1)
    assert compute_ew_layout(ROOF, p, 0.1)["panels"] == compute_layout(ROOF, p)["panels"]


def test_options_api_with_energy():
    r = client.post("/api/layout/options", json={"areas": [ROOF], "source": "offline"})
    assert r.status_code == 200
    opts = r.json()["options"]
    assert len(opts) == 4
    for o in opts:
        assert o["annual_kwh"] > 0 and o["energy_source"] == "offline"
        assert 900 < o["specific_yield"] < 2200
    assert opts[1]["annual_kwh"] > opts[0]["annual_kwh"]  # more panels, more energy


def test_options_api_empty_area():
    r = client.post("/api/layout/options", json={"areas": [rect(0, 0, 1, 1)], "source": "offline"})
    assert r.status_code == 200
    assert all(o["count"] == 0 and o["annual_kwh"] is None for o in r.json()["options"])
    assert client.post("/api/layout/options", json={"areas": [[[0, 0], [0, 1]]]}).status_code == 400


def test_east_west_api_keeps_the_users_gap():
    base = {"areas": [ROOF], "tilt_deg": by_key()["east_west"]["tilt_deg"]}
    auto = client.post("/api/layout/ew", json=base).json()
    wide = client.post("/api/layout/ew", json={**base, "row_spacing_m": 0.5}).json()
    assert auto["row_gap_m"] == layout.OPTION_EAST_WEST["row_gap_m"]
    assert auto["panels"] == by_key()["east_west"]["panels"]
    assert wide["row_gap_m"] == 0.5 and wide["count"] < auto["count"]
    assert [f["azimuth_deg"] for f in wide["faces"]] == [90, 270]


@pytest.mark.parametrize("key", ["economic", "east_west", "aesthetic"])
def test_every_proposal_works_in_the_next_steps(key, monkeypatch):
    """Shading, shadows, inverter/strings, production and the PDF accept each proposal as it is applied."""
    monkeypatch.setattr(mapimage, "_native_zoom", lambda c, lat, lon: 20)
    monkeypatch.setattr(mapimage, "_fetch_tile", lambda c, z, x, y: Image.new("RGB", (256, 256), (80, 110, 70)))
    o = by_key()[key]
    obstacles = [{"polygon": rect(-2, -9, 2, -7), "height_m": 5}]
    faces = [{"tilt_deg": f["tilt_deg"], "azimuth_deg": f["azimuth_deg"]} for f in o.get("faces", [])] or None
    common = {"panels": o["panels"], "obstacles": obstacles, "tilt_deg": o["tilt_deg"],
              "azimuth_deg": o["azimuth_deg"], "mounting": o["mounting"],
              "faces": faces, "panel_face": o.get("panel_face")}
    sh = client.post("/api/shading", json=common)
    assert sh.status_code == 200
    sh = sh.json()
    assert sh["row_shading"] and 0 <= sh["annual_loss_pct"] < 20
    assert client.post("/api/shadows", json={**common, "when": "2025-12-21T10:00:00Z"}).status_code == 200

    el = client.post("/api/electrical", json={
        "module": {"power_w": 410, "voc": 37.3, "isc": 13.9, "vmp": 31.0, "imp": 13.2},
        "n_modules": o["count"], "mounting": "rack",
        "face_modules": [f["count"] for f in o["faces"]] if faces else None})
    assert el.status_code == 200
    el = el.json()
    assert bool(el.get("faces")) == bool(faces)

    if faces:
        en_req = {"faces": [{**f, "kwp": lf["kwp"], "shading_monthly_pct": sf["monthly_loss_pct"]}
                            for f, lf, sf in zip(faces, o["faces"], sh["faces"])]}
    else:
        en_req = {"shading_monthly_pct": sh["monthly_loss_pct"]}
    en = client.post("/api/energy", json={"lat": LAT0, "lon": LON0, "kwp": o["kwp"], "tilt_deg": o["tilt_deg"],
                                          "azimuth_deg": o["azimuth_deg"], "source": "offline", **en_req})
    assert en.status_code == 200
    en = en.json()
    assert en["annual_kwh"] > 0

    lay = {k: o[k] for k in ("count", "kwp", "area_m2", "module_area_m2", "row_gap_m", "center", "panels")}
    if faces:
        lay.update(faces=o["faces"], panel_face=o["panel_face"])
    project = {"name": key, "areas": [ROOF], "keepouts": [], "layout": lay, "shading": sh, "energy": en,
               "settings": {"panel_power_w": 410, "panel_width_m": 1.134, "panel_length_m": 1.722,
                            "tilt_deg": o["tilt_deg"], "azimuth_deg": o["azimuth_deg"], "mounting": "rack",
                            "orientation": "portrait", "loss_pct": 14}}
    pdf = client.post("/api/report", json=project)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    rows = report.face_rows(project)
    assert (rows is not None) == bool(faces)
    if rows:
        assert [r["azimuth_deg"] for r in rows] == [90, 270] and all(r["annual_kwh"] for r in rows)


def test_lower_tilt_is_chosen_when_it_fits_one_more_row():
    """10 x 10 m south-facing roof, no setback: at 30° three rows fit, at 22° (and lower) four."""
    roof = rect(-5, -5, 5, 5)
    p = LayoutParams(setback_m=0)

    def rows(tilt):
        return compute_layout(roof, LayoutParams(setback_m=0, tilt_deg=tilt, mounting="rack"))["count"] // 8

    assert rows(30) == 3 and rows(23) == 3 and rows(22) == 4 and rows(20) == 4
    eco = layout_options([roof], p)[0]
    assert eco["key"] == "economic" and eco["tilt_deg"] == 22  # the most panels, closest to 30°
    assert eco["count"] == 4 * 8


def test_tie_keeps_the_nominal_tilt():
    tilt, res = layout.best_tilt(lambda t: {"count": 10}, 30, 20)
    assert tilt == 30
    tilt, _ = layout.best_tilt(lambda t: {"count": 10 if t > 25 else 12}, 30, 20)
    assert tilt == 25


def test_manual_proposal_uses_the_settings_as_they_are():
    p = LayoutParams(tilt_deg=25, azimuth_deg=170, mounting="flush")
    m = layout_options([ROOF], p)[3]
    assert m["key"] == "manual" and m["tilt_deg"] == 25 and m["azimuth_deg"] == 170 and m["mounting"] == "flush"
    assert m["panels"] == compute_layout(ROOF, p)["panels"] and not m["east_west"]
    ew = layout_options([ROOF], LayoutParams(tilt_deg=10, mounting="rack"), east_west=True)[3]
    assert ew["east_west"] and [f["azimuth_deg"] for f in ew["faces"]] == [90, 270]
    r = client.post("/api/layout/options", json={"areas": [ROOF], "source": "offline", "mounting": "rack",
                                                 "tilt_deg": 10, "east_west": True}).json()["options"][3]
    assert r["east_west"] and r["annual_kwh"] > 0
