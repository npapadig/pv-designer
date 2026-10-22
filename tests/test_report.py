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
    monkeypatch.setattr(mapimage, "_native_zoom", lambda c, src, lat, lon: 20)
    monkeypatch.setattr(mapimage, "_fetch_tile", lambda c, src, z, x, y: Image.new("RGB", (256, 256), (80, 110, 70)))


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


def _marked_tiles(monkeypatch, lat, lon, z=20, used=None):
    """Grey tiles with a red 6x6 mark at (lat, lon); records which base map was asked for."""
    mx, my = mapimage._world_px(lat, lon, z)

    def fetch(c, src, tz, x, y):
        if used is not None:
            used.add(src.key)
        t = Image.new("RGB", (256, 256), (120, 120, 120))
        if int(mx // 256) == x and int(my // 256) == y:
            px, py = int(mx - x * 256), int(my - y * 256)
            t.paste((255, 0, 0), (px - 3, py - 3, px + 3, py + 3))
        return t
    monkeypatch.setattr(mapimage, "_fetch_tile", fetch)


def test_map_image_frames_the_roof_and_lines_up_with_the_imagery(monkeypatch):
    """The picture keeps its 16:10 shape, the roof fills a good part of it (not a speck in a
    wide view), and a spot on the satellite tiles lands exactly under the same spot of the drawing."""
    import io
    area = square(12, 9)
    lat_c = sum(p[0] for p in area) / 4
    lon_c = sum(p[1] for p in area) / 4
    _marked_tiles(monkeypatch, lat_c, lon_c)
    jpeg, has_imagery = mapimage.render_layout([area], [], [], width=1600, height=1000)
    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    assert has_imagery and img.size == (1600, 1000)

    # Where the drawing puts the roof: orange outline pixels.
    px = img.load()
    orange = [(x, y) for x in range(0, 1600, 2) for y in range(0, 1000, 2)
              if px[x, y][0] > 200 and 120 < px[x, y][1] < 190 and px[x, y][2] < 80]
    xs, ys = [p[0] for p in orange], [p[1] for p in orange]
    roof_w, roof_h = max(xs) - min(xs), max(ys) - min(ys)
    assert roof_w > 1600 * 0.3, "η στέγη πρέπει να γεμίζει μεγάλο μέρος της εικόνας"
    assert 0 < min(xs) and max(xs) < 1600 and 0 < min(ys) and max(ys) < 1000
    assert abs(roof_w / roof_h - 12 / 9) < 0.05, "χωρίς παραμόρφωση"
    # The red mark (centre of the roof on the tiles) sits at the centre of the drawn roof.
    red = [(x, y) for x in range(1600) for y in range(1000) if px[x, y][0] > 200 and px[x, y][1] < 90]
    rx, ry = sum(p[0] for p in red) / len(red), sum(p[1] for p in red) / len(red)
    assert abs(rx - (min(xs) + max(xs)) / 2) < 6 and abs(ry - (min(ys) + max(ys)) / 2) < 6


def test_map_image_uses_the_base_map_on_screen(monkeypatch):
    area = square(12, 9)
    for basemap in ("esri", "clarity", "streets", "ktimatologio"):
        used = set()
        _marked_tiles(monkeypatch, *area[0], used=used)
        assert mapimage.render_layout([area], [], [], basemap=basemap)[1]
        assert used == {basemap}
    # Google without a working key falls back to Esri instead of failing.
    used = set()
    _marked_tiles(monkeypatch, *area[0], used=used)
    monkeypatch.setattr(mapimage, "google_source", lambda c, key, lat, lon: None)
    assert mapimage.render_layout([area], [], [], basemap="google", google_key="x")[1]
    assert used == {"esri"}


def test_map_image_big_site_downloads_a_sensible_number_of_tiles(monkeypatch):
    calls = []
    monkeypatch.setattr(mapimage, "_fetch_tile", lambda c, src, z, x, y: calls.append(z) or Image.new("RGB", (256, 256)))
    mapimage.render_layout([square(400, 250)], [], [])
    assert len(calls) <= 120 and max(calls) < 20


def test_report_asks_for_the_base_map_of_the_screen(monkeypatch):
    seen = {}
    monkeypatch.setattr(report.settings, "load", lambda: {"google_maps_key": "KEY"})
    monkeypatch.setattr(mapimage, "render_layout", lambda *a, **kw: seen.update(kw) or (b"x", True))
    report.ReportContext(make_project(basemap="google")).map_image()
    assert seen["basemap"] == "google" and seen["google_key"] == "KEY"
    report.ReportContext(make_project()).map_image()
    assert seen["basemap"] == "esri" and seen["google_key"] == ""


def test_cadastre_tiles_cover_the_map_tile():
    url, params = mapimage._tile_request(mapimage.SOURCES["ktimatologio"], 19, 296710, 202278)
    w, s, e, n = map(float, params["BBOX"].split(","))
    x0, y0 = mapimage._world_px(n, w, 19)
    x1, y1 = mapimage._world_px(s, e, 19)
    assert abs(x0 - 296710 * 256) < 1e-6 and abs(y1 - 202279 * 256) < 1e-6 and abs(x1 - x0 - 256) < 1e-6


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
