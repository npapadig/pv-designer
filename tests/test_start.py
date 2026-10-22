"""Start of a project (stream arxi): project kind, start screen choices."""
from fastapi.testclient import TestClient

from backend import storage
from backend.main import app

client = TestClient(app)


def test_project_type_is_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    for kind in ("existing", "new", "park"):
        pid = client.post("/api/projects", json={"name": kind, "project_type": kind}).json()["id"]
        assert client.get(f"/api/projects/{pid}").json()["project_type"] == kind


def test_start_screen_offers_three_kinds():
    html = client.get("/").text
    for el in ('id="homeBuilding"', 'id="homeNewBuilding"', 'id="homePark"', 'id="planAsk"'):
        assert el in html
