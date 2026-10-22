"""PDF report in Greek or English.

The Greek report must stay exactly as it was: every piece of text drawn on its pages is compared with
tests/report_text_el.json (made from the report before English existed). After an intended change of the
Greek texts, regenerate it with:  python -m tests.test_report_lang --write
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfgen import textobject

from backend import finance, i18n, report, shading, simulation
from backend.electrical import Module, design
from backend.layout import LayoutParams, compute_layout
from backend.main import app
from tests.test_layout import square
from tests.test_report import make_project
from tests.test_shading import flush_panels, rect

GOLDEN = Path(__file__).with_name("report_text_el.json")
GREEK = re.compile(r"[Ͱ-Ͽἀ-῿]")
MODULE = Module(power_w=410, voc=37.3, isc=13.9, vmp=31.0, imp=13.2)


class _FixedDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 10, 22)


def projects() -> dict[str, dict]:
    """Sample projects that together use every text of the report."""
    from tests.test_faces import _faces_project

    sim = simulation.simulate(37.98, 23.72, 20, 180, 5.0, 4.0, weather=simulation.clearsky_weather(37.98, 23.72))
    lay = compute_layout(square(15, 10), LayoutParams(tilt_deg=20))
    full = make_project(
        energy=sim,
        shading=shading.analyze(flush_panels(), [{"polygon": rect(-2, -7, 2, -5), "height_m": 4}], 30, 180, "rack"),
        electrical=design(MODULE, lay["count"], phases="1"),
        finance=finance.analyse(finance.FinanceParams(kwp=lay["kwp"], annual_kwh=sim["annual_kwh"], subsidy_eur=1000)),
        keepouts=[rect(-2, -7, 2, -5)],
    )
    full["settings"].update(mounting="rack", orientation="landscape", panel_name="Δοκιμαστικό 410")
    offline = make_project()
    offline["energy"] = {**offline["energy"], "source": "offline"}
    return {
        "basic": make_project(),
        "no_energy": make_project(energy=None, report_info={}),
        "offline": offline,
        "full": full,
        "faces": _faces_project()[0],
    }


def drawn_text(project: dict, **kw) -> list[str]:
    """Every piece of text drawn on the pages of the report, in order (no satellite imagery, fixed date)."""
    seen = []
    orig = textobject.PDFTextObject._formatText

    def spy(self, text):
        seen.append(text)
        return orig(self, text)

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(textobject.PDFTextObject, "_formatText", spy)
        mp.setattr(report, "date", _FixedDate)
        report.build_pdf(project, imagery=False, **kw)
    finally:
        mp.undo()
    return seen


@pytest.fixture(scope="module")
def samples():
    return projects()


def test_greek_report_is_exactly_as_before(samples):
    expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert sorted(samples) == sorted(expected)
    for name, project in samples.items():
        assert drawn_text(project) == expected[name], name
        assert drawn_text(project, lang="el") == expected[name], name
        assert drawn_text(project, lang="xx") == expected[name], name  # unknown language: Greek


def test_english_report_has_no_greek(samples):
    latin = {"client": "George", "address": "Ermou 1, Athens", "author": "Company"}
    for name, project in samples.items():
        project = {**project, "name": "House", "report_info": latin,
                   "settings": {**project["settings"], "panel_name": "Test 410"}}
        text = drawn_text(project, lang="en")
        assert [t for t in text if GREEK.search(t)] == [], name
        assert any(t.startswith("Page 2 of ") for t in text), name


def test_english_report_numbers_and_words(samples):
    text = drawn_text(samples["full"], lang="en")
    assert "PHOTOVOLTAIC SYSTEM STUDY" in text and "Energy losses" in text and "Financial analysis" in text
    assert any("kWp / 20.0 kW" in t for t in text)  # electrical summary: 24,60 kWp / 20,0 kW in Greek
    assert "4 × Single-phase 5 kW (2 MPPT)" in text
    assert drawn_text(samples["basic"], lang="en")[3] == "24.60"  # cover KPI, 24,60 in Greek


def test_greek_texts_come_back_unchanged():
    for text in ("Σύνολο", "60 από 60", "11.000 €", "", None, 5, "  από άμεσο ήλιο"):
        assert i18n.tr(text) is text and i18n.tr(text, "el") is text


def test_english_rules():
    tr = lambda t, context="": i18n.tr(t, "en", context)
    assert tr("Πάνελ") == "Panels" and tr("Πάνελ", context="model") == "Panel"
    assert tr("  από άμεσο ήλιο") == "  from direct sunlight"
    assert tr("60 από 60") == "60 of 60" and tr("-10 έως 65 °C") == "-10 to 65 °C"
    assert tr("11.000 €") == "11,000 €" and tr("1.234,5 kWh") == "1,234.5 kWh" and tr("8,3 έτη") == "8.3 years"
    assert tr("έως 1.100 V") == "up to 1,100 V" and tr("από 80 V") == "from 80 V"
    assert tr("Τριφασικός 10 kW (2 MPPT)") == "Three-phase 10 kW (2 MPPT)"
    # Numbers the engine writes the English way (Python's 1.42) stay as they are.
    assert tr("Λόγος DC/AC 1.42: ο inverter είναι μεγαλύτερος από όσο χρειάζεται.") == \
        "DC/AC ratio 1.42: the inverter is bigger than needed."
    assert tr("Κάτι καινούργιο") == "Κάτι καινούργιο"  # unknown: stays Greek


def test_every_electrical_check_has_english():
    """Texts of backend/electrical.py that go into the report (warnings and errors)."""
    texts = [
        "Η τάση του string στο κρύο (-10 °C) φτάνει 812 V και ξεπερνά το όριο του inverter (600 V). "
        "Μπορεί να καταστραφεί ο inverter. Βάλε έως 14 πάνελ σε σειρά.",
        "Στη ζέστη (κύτταρα 65 °C) η τάση πέφτει στα 52 V, κάτω από το κατώτατο όριο λειτουργίας του inverter "
        "(200 V). Θα χάνεται παραγωγή. Βάλε τουλάχιστον 8 πάνελ σε σειρά.",
        "Στο κρύο η τάση λειτουργίας (612 V) ξεπερνά το πάνω όριο MPPT (550 V). Τις κρύες μέρες ο inverter δεν "
        "θα δουλεύει στο βέλτιστο σημείο.",
        "Συνδέονται 3 strings σε ένα MPPT, ενώ ο inverter έχει 2 είσοδο(ους).",
        "Το ρεύμα βραχυκύκλωσης ανά MPPT (41.7 A) ξεπερνά το όριο του inverter (22 A).",
        "Το ρεύμα ανά MPPT (26.4 A) ξεπερνά το μέγιστο ρεύμα εισόδου (16 A). Ο inverter θα κόβει λίγη παραγωγή.",
        "Οι πλευρές της στέγης (3) χρειάζονται περισσότερα MPPT από όσα έχει ο inverter (2): 1 string(s) "
        "μοιράζονται MPPT με άλλη πλευρά και χάνεται λίγη παραγωγή και 2 string(s) δεν χωρούν σε κανένα MPPT και "
        "μένουν ασύνδετα. Διάλεξε inverter με περισσότερα MPPT ή περισσότερους inverters.",
    ]
    m = MODULE
    configs = [dict(n_modules=n) for n in (10, 24, 57, 120, 600)] + [
        dict(n_modules=24, modules_per_string=20), dict(n_modules=24, modules_per_string=2),
        dict(n_modules=60, phases="1"), dict(n_modules=25, face_modules=[20, 3, 2]),
        dict(n_modules=30, face_modules=[15, 15], mix_faces=True),
    ]
    for c in configs:
        d = design(m, **c)
        texts += [ch["text"] for ch in d["checks"] if ch["level"] != "ok"]
        texts += [x for row in d["report"]["summary"] for x in row]
        texts += [x for t in d["report"]["tables"] for x in [t["title"], *t["columns"], *sum(t["rows"], [])]]
    left = [t for t in texts if GREEK.search(i18n.tr(t, "en"))]
    assert left == []


def test_every_finance_and_shading_text_has_english():
    texts = []
    for scheme in ("self", "net_billing", "net_metering"):
        for kw in ({}, {"subsidy_eur": 2000, "inverter_replacement_year": 0}, {"capex_per_kwp": 9000}):
            block = finance.analyse(finance.FinanceParams(kwp=5, annual_kwh=7500, scheme=scheme, **kw))["report"]
            texts += [x for row in block["summary"] for x in row] + block["notes"]
            texts += [x for t in block["tables"] for x in [t["title"], *t["columns"]]]
    for obstacles, mounting in (([], "flush"), ([{"polygon": rect(-2, -7, 2, -5), "height_m": 4}], "rack")):
        block = shading.analyze(flush_panels(), obstacles, 30, 180, mounting)["report"]
        texts += [x for row in block["summary"] for x in row] + block["notes"]
        texts += [x for t in block["tables"] for x in [t["title"], *t["columns"], *sum(t["rows"], [])]]
    left = [t for t in texts if GREEK.search(i18n.tr(t, "en"))]
    assert left == []


def test_report_endpoint_in_english(tmp_path, monkeypatch):
    client = TestClient(app)
    project = make_project()
    r = client.post("/api/report", json={**project, "lang": "en"})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert "filename*=UTF-8''PV%20study%20-%20" in r.headers["content-disposition"]
    r = client.post("/api/report", json=project)
    assert "filename*=UTF-8''%CE%9C%CE%B5" in r.headers["content-disposition"]  # "Με..." (Μελέτη ΦΒ)

    from backend import storage
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path)
    pid = client.post("/api/projects", json=project).json()["id"]
    r = client.get(f"/api/projects/{pid}/report?lang=en")
    assert r.status_code == 200 and "PV%20study" in r.headers["content-disposition"]
    assert "PV%20study" not in client.get(f"/api/projects/{pid}/report").headers["content-disposition"]


if __name__ == "__main__" and "--write" in sys.argv:
    GOLDEN.write_text(json.dumps({n: drawn_text(p) for n, p in projects().items()}, ensure_ascii=False, indent=0),
                      encoding="utf-8")
    print(f"OK: {GOLDEN}")
