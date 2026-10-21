"""Roof faces: each face has its own tilt and azimuth; layout, shading and production per face, then summed."""
from fastapi.testclient import TestClient

from backend import energy, shading, simulation
from backend.layout import LayoutParams, compute_faces_layout, compute_layout, split_area
from backend.main import app
from tests.test_layout import LAT0, LON0
from tests.test_shading import rect

client = TestClient(app)

# Gable roof 10 x 8 m: south half and north half.
SOUTH = rect(-5, -4, 5, 0)
NORTH = rect(-5, 0, 5, 4)
GABLE = [{"area": SOUTH, "tilt_deg": 30, "azimuth_deg": 180}, {"area": NORTH, "tilt_deg": 30, "azimuth_deg": 0}]


def test_faces_layout_is_the_sum_of_each_face():
    p = LayoutParams(setback_m=0.3)
    res = compute_faces_layout(GABLE, p)
    south = compute_layout(SOUTH, LayoutParams(setback_m=0.3, tilt_deg=30, azimuth_deg=180))
    north = compute_layout(NORTH, LayoutParams(setback_m=0.3, tilt_deg=30, azimuth_deg=0))
    assert res["count"] == south["count"] + north["count"] > 0
    assert res["panel_face"] == [0] * south["count"] + [1] * north["count"]
    assert res["panels"] == south["panels"] + north["panels"]
    assert [f["count"] for f in res["faces"]] == [south["count"], north["count"]]
    assert res["faces"][1]["azimuth_deg"] == 0
    assert res["kwp"] == round(res["count"] * p.panel_power_w / 1000, 3)


def test_face_without_own_angles_uses_the_common_ones():
    p = LayoutParams(tilt_deg=20, azimuth_deg=200)
    res = compute_faces_layout([{"area": SOUTH}], p)
    one = compute_layout(SOUTH, p)
    assert res["panels"] == one["panels"]
    assert res["faces"][0]["tilt_deg"] == 20 and res["faces"][0]["azimuth_deg"] == 200


def test_shading_with_one_face_matches_the_old_way():
    lay = compute_layout(SOUTH, LayoutParams(tilt_deg=30))
    obstacles = [{"polygon": rect(-2, -8, 2, -6), "height_m": 4}]
    old = shading.analyze(lay["panels"], obstacles, 30, 180, "flush")
    new = shading.analyze(lay["panels"], obstacles, 30, 180, "flush",
                          [{"tilt_deg": 30, "azimuth_deg": 180}], [0] * lay["count"])
    faces = new.pop("faces")
    assert new == old
    assert faces[0]["panels"] == lay["count"]
    assert faces[0]["annual_loss_pct"] == old["annual_loss_pct"]


def test_obstacle_south_of_the_roof_shades_the_south_face_more():
    lay = compute_faces_layout(GABLE, LayoutParams(setback_m=0.3))
    obstacles = [{"polygon": rect(-3, -7, 3, -5), "height_m": 6}]
    res = shading.analyze(lay["panels"], obstacles, 30, 180, "flush",
                          [{"tilt_deg": f["tilt_deg"], "azimuth_deg": f["azimuth_deg"]} for f in lay["faces"]],
                          lay["panel_face"])
    south, north = res["faces"]
    assert south["annual_loss_pct"] > north["annual_loss_pct"]
    assert south["panels"] + north["panels"] == lay["count"]
    assert len(res["panel_loss_pct"]) == lay["count"]
    assert min(south["annual_loss_pct"], north["annual_loss_pct"]) <= res["annual_loss_pct"] <= max(
        south["annual_loss_pct"], north["annual_loss_pct"])


def test_racked_faces_with_different_tilt():
    flat_roof = [{"area": rect(-6, -6, 0, 6), "tilt_deg": 10, "azimuth_deg": 180},
                 {"area": rect(0, -6, 6, 6), "tilt_deg": 35, "azimuth_deg": 180}]
    lay = compute_faces_layout(flat_roof, LayoutParams(mounting="rack", setback_m=0.3))
    res = shading.analyze(lay["panels"], [], 10, 180, "rack",
                          [{"tilt_deg": 10, "azimuth_deg": 180}, {"tilt_deg": 35, "azimuth_deg": 180}],
                          lay["panel_face"])
    assert res["row_shading"]
    assert all(0 <= f["annual_loss_pct"] < 15 for f in res["faces"])


def test_shading_rejects_wrong_panel_faces():
    lay = compute_layout(SOUTH, LayoutParams())
    r = client.post("/api/shading", json={"panels": lay["panels"], "faces": [{"tilt_deg": 30, "azimuth_deg": 180}],
                                          "panel_face": [3] * lay["count"]})
    assert r.status_code == 400
    r = client.post("/api/shading", json={"panels": lay["panels"], "faces": [{"tilt_deg": 30, "azimuth_deg": 180}]})
    assert r.status_code == 400


def test_energy_one_face_matches_the_old_way():
    old = energy.estimate(LAT0, LON0, 5.0, 30, 180, 14, "offline")
    new = energy.estimate_faces(LAT0, LON0, [{"kwp": 5.0, "tilt_deg": 30, "azimuth_deg": 180}], 14, "offline")
    assert new["annual_kwh"] == old["annual_kwh"]
    assert [m["kwh"] for m in new["monthly"]] == [m["kwh"] for m in old["monthly"]]
    assert new["annual_irradiation"] == old["annual_irradiation"]


def test_energy_of_faces_is_the_sum_and_north_yields_less():
    faces = [{"kwp": 4.0, "tilt_deg": 30, "azimuth_deg": 180},
             {"kwp": 2.0, "tilt_deg": 30, "azimuth_deg": 0, "shading_monthly_pct": [5.0] * 12}]
    res = energy.estimate_faces(LAT0, LON0, faces, 14, "offline")
    south, north = res["faces"]
    assert res["annual_kwh"] == south["annual_kwh"] + north["annual_kwh"]
    assert north["specific_yield"] < south["specific_yield"]
    assert north["shading_loss_pct"] == 5.0 and south["shading_loss_pct"] == 0.0
    assert res["annual_kwh"] < res["annual_kwh_unshaded"]
    assert 0 < res["shading_loss_pct"] < 5
    assert len(res["monthly"]) == 12


def test_simulation_one_face_matches_the_old_way():
    w = simulation.clearsky_weather(LAT0, LON0)
    shade = [3.0] * 12
    old = simulation.simulate(LAT0, LON0, 30, 180, 10.0, 8.0, shading_monthly_pct=shade, weather=w)
    new = simulation.simulate(LAT0, LON0, 30, 180, 10.0, 8.0, weather=w,
                              faces=[{"dc_kwp": 10.0, "tilt": 30, "azimuth": 180, "shading_monthly_pct": shade}])
    faces = new.pop("faces")
    assert new["annual_kwh"] == old["annual_kwh"]
    assert new["loss_steps"] == old["loss_steps"]
    assert abs(new["annual_kwh_unshaded"] - old["annual_kwh_unshaded"]) <= 2
    assert faces[0]["annual_kwh"] == old["annual_kwh"]


def test_simulation_east_west_faces_share_one_inverter():
    w = simulation.clearsky_weather(LAT0, LON0)
    east_west = [{"dc_kwp": 5.0, "tilt": 20, "azimuth": 90}, {"dc_kwp": 5.0, "tilt": 20, "azimuth": 270}]
    ew = simulation.simulate(LAT0, LON0, 30, 180, 10.0, 6.0, weather=w, faces=east_west)
    south = simulation.simulate(LAT0, LON0, 20, 180, 10.0, 6.0, weather=w)
    clip = lambda r: next(l["kwh"] for l in r["loss_steps"] if l["key"] == "clipping")
    # East and west peak at different hours, so the inverter clips less than with all panels facing south.
    assert clip(ew) < clip(south)
    assert abs(sum(f["annual_kwh"] for f in ew["faces"]) - ew["annual_kwh"]) <= 2
    assert ew["dc_kwp"] == 10.0


def test_simulation_face_shares_scale_to_the_designed_power():
    w = simulation.clearsky_weather(LAT0, LON0)
    res = simulation.simulate(LAT0, LON0, 30, 180, 9.0, 8.0, weather=w,
                              faces=[{"dc_kwp": 6.0, "tilt": 30, "azimuth": 180}, {"dc_kwp": 4.0, "tilt": 30, "azimuth": 0}])
    assert [f["kwp"] for f in res["faces"]] == [5.4, 3.6]


def test_faces_api_end_to_end():
    lay = client.post("/api/layout/faces", json={"faces": GABLE, "setback_m": 0.3})
    assert lay.status_code == 200
    lay = lay.json()
    faces = [{"tilt_deg": f["tilt_deg"], "azimuth_deg": f["azimuth_deg"]} for f in lay["faces"]]
    sh = client.post("/api/shading", json={"panels": lay["panels"], "faces": faces, "panel_face": lay["panel_face"],
                                           "obstacles": [{"polygon": rect(-3, -7, 3, -5), "height_m": 6}]})
    assert sh.status_code == 200
    sh = sh.json()
    en = client.post("/api/energy", json={
        "lat": LAT0, "lon": LON0, "kwp": lay["kwp"], "source": "offline",
        "faces": [{**f, "kwp": lf["kwp"], "shading_monthly_pct": sf["monthly_loss_pct"]}
                  for f, lf, sf in zip(faces, lay["faces"], sh["faces"])],
    })
    assert en.status_code == 200
    en = en.json()
    assert len(en["faces"]) == 2 and en["annual_kwh"] > 0
    shadows = client.post("/api/shadows", json={"panels": lay["panels"], "faces": faces, "panel_face": lay["panel_face"],
                                                "when": "2025-12-21T10:00:00Z",
                                                "obstacles": [{"polygon": rect(-3, -7, 3, -5), "height_m": 6}]})
    assert shadows.status_code == 200 and shadows.json()["shadows"]


def _m2(latlngs):
    return compute_layout(latlngs, LayoutParams())["area_m2"]


def test_split_along_the_ridge_gives_two_faces_facing_away_from_it():
    roof = rect(-5, -4, 5, 4)
    ridge = rect(-4.5, 0, 4.5, 0)[:2]  # stops short of both gable ends; the ends are lengthened
    pieces = split_area(roof, ridge)
    assert len(pieces) == 2
    by_az = {p["azimuth_deg"]: p for p in pieces}
    assert set(by_az) == {0, 180}
    assert abs(_m2(by_az[180]["area"]) - 40) < 0.5 and abs(_m2(by_az[0]["area"]) - 40) < 0.5
    # The south piece is the one south of the ridge.
    assert max(lat for lat, _ in by_az[180]["area"]) <= max(lat for lat, _ in by_az[0]["area"])


def test_split_with_a_bent_line_and_a_line_that_misses():
    roof = rect(-5, -4, 5, 4)
    bent = [rect(-6, -4, -6, -4)[0], rect(0, 2, 0, 2)[0], rect(6, -4, 6, -4)[0]]
    pieces = split_area(roof, bent)
    assert len(pieces) == 2
    assert abs(sum(_m2(p["area"]) for p in pieces) - 80) < 0.5
    outside = [rect(20, 20, 20, 20)[0], rect(30, 20, 30, 20)[0]]
    assert len(split_area(roof, outside)) == 1


def test_split_api():
    r = client.post("/api/split", json={"area": rect(-5, -4, 5, 4), "line": rect(-6, 0, 6, 0)[:2]})
    assert r.status_code == 200 and len(r.json()["pieces"]) == 2
    assert client.post("/api/split", json={"area": rect(-5, -4, 5, 4), "line": [[LAT0, LON0]]}).status_code == 400
