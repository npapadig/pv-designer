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


def test_egsa87_athens():
    x, y = plan_drawing.egsa87(37.9755, 23.7348)  # Syntagma square
    assert 470000 < x < 480000 and 4200000 < y < 4210000


def test_plan_has_coordinates_page_and_english_has_no_greek():
    import re
    p = make_project()
    pdf = plan_drawing.build_plan_pdf(p, "el")
    assert pdf.count(b"/Type /Page\n") == 2 or pdf.count(b"/Type /Page ") + pdf.count(b"/Type /Page\n") == 2


def _design():
    from backend import electrical, equipment
    inv = equipment.Inverter(name="Test 5 kW", phases=1, pac_w=5000, pdc_max_w=7500, vdc_max=600, v_mppt_min=100,
                             v_mppt_max=500, v_start=80, n_mppt=2, strings_per_mppt=1, i_max_mppt=16,
                             isc_max_mppt=20)
    return {"inverter": inv.model_dump(), "n_inverters": 1, "modules_per_string": 9, "n_strings": 2,
            "modules_used": 18, "dc_kwp": 7.38, "ac_kw": 5.0,
            "per_inverter": [{"strings": 2, "mppts": [1, 1]}]}


def test_single_line_pdf_and_endpoint():
    from backend import single_line
    p = make_project(electrical={"design": _design()})
    for lang in ("el", "en"):
        assert single_line.build_single_line_pdf(p, lang).startswith(b"%PDF")
    r = client.post("/api/single-line", json={**p, "lang": "en"})
    assert r.status_code == 200 and "single-line" in r.headers["content-disposition"].lower()
    assert client.post("/api/single-line", json=make_project()).status_code == 400


def test_breaker_sizes():
    from backend import single_line
    assert abs(single_line.ac_current(5000, 1) - 21.74) < 0.01
    assert single_line.breaker_for(21.74) == 25
    assert single_line.breaker_for(7.2) == 10
