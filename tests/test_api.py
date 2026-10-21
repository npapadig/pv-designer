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
