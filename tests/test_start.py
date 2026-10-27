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


def test_roof_type_is_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    for roof in ("flat", "pitched"):
        pid = client.post("/api/projects", json={"name": roof, "roof_type": roof}).json()["id"]
        assert client.get(f"/api/projects/{pid}").json()["roof_type"] == roof


def test_start_screen_offers_rooftop_and_park():
    html = client.get("/").text
    for el in ('id="homeRooftop"', 'id="homePark"', 'id="homeName"', 'id="homeEngineer"', 'id="planAsk"'):
        assert el in html


def test_search_suggestions_are_wired():
    html = client.get("/").text
    assert 'id="searchList"' in html and "search.js?v=" in html
    assert client.get("/search.js").headers["content-type"].startswith("text/javascript")


def test_google_box_is_gone():
    # The key is entered from the map menu ("Κλειδί Google…", app.js) when there is none.
    html = client.get("/").text
    assert 'id="googleBox"' not in html and 'id="googleKey"' not in html


def test_roof_question_and_switch():
    html = client.get("/").text
    for el in ('id="roofRow"', 'name="roofType" value="flat"'):
        assert el in html


def test_engineer_name_is_saved_and_printed(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    info = {"client": "X", "engineer": "Γ. Παπαδόπουλος"}
    pid = client.post("/api/projects", json={"name": "e", "report_info": info}).json()["id"]
    assert client.get(f"/api/projects/{pid}").json()["report_info"]["engineer"] == "Γ. Παπαδόπουλος"
