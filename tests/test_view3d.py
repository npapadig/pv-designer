"""3D view (stream trisdiastato): the page loads the module and the three.js it uses; nothing is calculated there."""
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)
FRONT = Path(__file__).resolve().parent.parent / "frontend"


def test_page_has_3d_button_and_module():
    html = client.get("/").text
    assert 'id="btn3d"' in html
    assert '<script type="module" src="view3d.js?v=' in html and 'href="view3d.css?v=' in html
    assert client.get("/view3d.js").headers["content-type"].startswith("text/javascript")


def test_view3d_reuses_existing_three_and_changes_no_results():
    js = (FRONT / "view3d.js").read_text(encoding="utf-8")
    assert 'from "./vendor/three/three.module.min.js"' in js
    assert "fetch(" not in js and "api(" not in js  # reads the project only, no new calculation
