from fastapi.testclient import TestClient

from backend import storage
from backend.main import app
from tests.test_layout import square

client = TestClient(app)


def test_layout_endpoint():
    r = client.post("/api/layout", json={"area": square(15, 10), "tilt_deg": 20})
    assert r.status_code == 200
    assert r.json()["count"] > 0


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "PV Designer" in r.text


def test_projects_crud(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    r = client.post("/api/projects", json={"name": "Σπίτι"})
    pid = r.json()["id"]
    assert client.get("/api/projects").json()[0]["name"] == "Σπίτι"
    client.put(f"/api/projects/{pid}", json={"name": "Σπίτι 2"})
    assert client.get(f"/api/projects/{pid}").json()["name"] == "Σπίτι 2"
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert client.get("/api/projects/../../etc").status_code == 404


MODULE = {"power_w": 410, "voc": 37.3, "isc": 13.9, "vmp": 31.0, "imp": 13.2}


def test_inverters_endpoint():
    r = client.get("/api/inverters")
    assert r.status_code == 200
    assert len(r.json()) >= 10


def test_electrical_endpoint():
    r = client.post("/api/electrical", json={"module": MODULE, "n_modules": 24})
    assert r.status_code == 200
    assert r.json()["ok"]
    inv = client.get("/api/inverters").json()[0]
    r = client.post("/api/electrical", json={"module": MODULE, "n_modules": 1, "inverter": inv, "modules_per_string": 1})
    assert r.status_code == 200


def test_simulate_endpoint_offline(monkeypatch, tmp_path):
    from backend import simulation

    def boom(*a, **k):
        raise RuntimeError("offline")
    monkeypatch.setattr(simulation, "fetch_pvgis_tmy", boom)
    monkeypatch.setattr(simulation, "WEATHER_DIR", tmp_path)
    r = client.post("/api/simulate", json={"lat": 37.98, "lon": 23.72, "dc_kwp": 5, "ac_kw": 4})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "offline" and body["warning"]
    assert body["loss_steps"]


def test_index_links_assets_with_version():
    from backend.main import VERSION
    r = client.get("/")
    assert r.status_code == 200
    assert f"style.css?v={VERSION}" in r.text and f"ui.js?v={VERSION}" in r.text
    assert "__VERSION__" not in r.text
    assert r.headers["cache-control"] == "no-cache"
    assert client.get("/style.css").headers["cache-control"] == "no-cache"


def test_frontend_assets_have_browser_types():
    assert client.get("/style.css").headers["content-type"].startswith("text/css")
    assert client.get("/ui.js").headers["content-type"].startswith("text/javascript")


def test_settings_roundtrip(tmp_path, monkeypatch):
    from backend import settings
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    assert client.get("/api/settings").json() == {"google_maps_key": ""}
    r = client.put("/api/settings", json={"google_maps_key": "  AIzaTEST  ", "other": "x"})
    assert r.json() == {"google_maps_key": "AIzaTEST"}
    assert client.get("/api/settings").json()["google_maps_key"] == "AIzaTEST"
    assert not (tmp_path / "other").exists()
