import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import energy, mapimage, report
from backend.layout import LayoutParams, compute_layout
from backend.main import app
from tests.test_energy import SAMPLE_PVGIS
from tests.test_layout import square

client = TestClient(app)


@pytest.fixture(autouse=True)
def fake_tiles(monkeypatch):
    """No network in tests: every satellite tile is plain green."""
    monkeypatch.setattr(mapimage, "_native_zoom", lambda c, lat, lon: 20)
    monkeypatch.setattr(mapimage, "_fetch_tile", lambda c, z, x, y: Image.new("RGB", (256, 256), (80, 110, 70)))


def make_project(**extra):
    area = square(15, 10)
    lay = compute_layout(area, LayoutParams(tilt_deg=20))
    return {
        "name": "Σπίτι Αθήνα",
        "settings": {"panel_power_w": 410, "panel_width_m": 1.134, "panel_length_m": 1.722, "tilt_deg": 20,
                     "azimuth_deg": 180, "mounting": "flush", "orientation": "portrait", "loss_pct": 14},
        "areas": [area],
        "keepouts": [],
        "layout": {**{k: lay[k] for k in ("count", "kwp", "area_m2", "module_area_m2", "row_gap_m", "center")},
                   "panels": lay["panels"]},
        "energy": energy.parse_pvgis(SAMPLE_PVGIS, lay["kwp"], 14),
        "report_info": {"client": "Γιώργος", "address": "Ερμού 1, Αθήνα", "author": "Εταιρεία"},
        **extra,
    }


def rendered_sections(project):
    ctx = report.ReportContext(project, imagery=False)
    return [fn.__name__ for _, fn in report.SECTIONS if fn(ctx)]


def test_build_pdf():
    pdf = report.build_pdf(make_project())
    assert pdf.startswith(b"%PDF")
    assert pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") >= 4


def test_pdf_without_internet_or_energy():
    p = make_project(energy=None)
    pdf = report.build_pdf(p, imagery=False)
    assert pdf.startswith(b"%PDF")
    assert "production_section" not in rendered_sections(p)
    assert "losses_section" not in rendered_sections(p)


def test_optional_sections_appear_only_with_data():
    assert "finance_section" not in rendered_sections(make_project())
    p = make_project(finance={"report": {"summary": [["Κόστος", "8.500 €"]],
                                         "tables": [{"title": "Ροές", "columns": ["Έτος", "€"], "rows": [[1, 100]]}],
                                         "notes": ["Σημείωση"]}})
    assert "finance_section" in rendered_sections(p)
    assert report.build_pdf(p, imagery=False).startswith(b"%PDF")


def test_loss_steps_end_at_annual_production():
    ctx = report.ReportContext(make_project(), imagery=False)
    nominal, steps, final = report.loss_steps(ctx)
    assert final == ctx.energy["annual_kwh"]
    assert abs(nominal - sum(kwh for _, _, kwh in steps) - final) < 1e-6
    assert [s[0] for s in steps][0].startswith("Γωνία")


def test_map_image_without_imagery():
    p = make_project()
    img, has_imagery = mapimage.render_layout(p["areas"], [], p["layout"]["panels"], imagery=False)
    assert img[:2] == b"\xff\xd8" and not has_imagery


def test_report_endpoint():
    r = client.post("/api/report", json=make_project())
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert "filename*=UTF-8''" in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF")


def test_report_endpoint_needs_a_drawing():
    assert client.post("/api/report", json={"name": "κενό"}).status_code == 400


def test_greek_number_format():
    assert report.num(12345.67, 1) == "12.345,7"
    assert report.signed_pct(2.6) == "−2,6%" and report.signed_pct(-0.9) == "+0,9%"
