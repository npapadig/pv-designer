import pytest
from fastapi.testclient import TestClient

from backend import plan_drawing
from backend.main import app
from tests.test_report import make_project

client = TestClient(app)


def test_pick_scale_fits():
    n = plan_drawing.pick_scale(15, 10, 250 * plan_drawing.mm, 150 * plan_drawing.mm)
    assert n in plan_drawing.SCALES and 15 * 1000 / n * plan_drawing.mm <= 250 * plan_drawing.mm
    assert plan_drawing.pick_scale(5000, 5000, 100, 100) == plan_drawing.SCALES[-1]


def test_plan_pdf_greek_and_english():
    p = make_project()
    for lang in ("el", "en"):
        pdf = plan_drawing.build_plan_pdf(p, lang)
        assert pdf.startswith(b"%PDF") and len(pdf) > 2000
    assert plan_drawing.build_plan_pdf(p, "el", "a3").startswith(b"%PDF")


def test_plan_pdf_needs_drawing():
    with pytest.raises(ValueError):
        plan_drawing.build_plan_pdf({"name": "x"})


def test_plan_endpoint():
    r = client.post("/api/plan-drawing", json={**make_project(), "lang": "en"})
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert "PV%20floor%20plan" in r.headers["content-disposition"]
    assert client.post("/api/plan-drawing", json={"name": "x"}).status_code == 400
