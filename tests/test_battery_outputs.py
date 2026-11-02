"""The battery in the documents (backend/battery_report.py): report, single-line, technical description,
Appendix I and the phone. Without a battery nothing changes; missing dispatch / finance data is tolerated."""
import copy
import re

import pytest
from reportlab.pdfgen import textobject

from backend import appendix_i, battery_report, report, single_line, tech_description
from backend.electrical import Module, design
from tests.test_report import make_project

MODULE = Module(power_w=410, voc=37.3, isc=13.9, vmp=31.0, imp=13.2)

RESULT = {"daily_kwh": 6.5, "peak_kw": 3.2, "target_days": 1.0, "needed_capacity_kwh": 8.0, "needed_power_kw": 3.2,
          "battery": {"capacity_kwh": 10.0, "power_kw": 5.0, "power_auto": True, "usable_kwh": 9.0, "guaranteed_kwh": 9.0,
                      "days_full": 1.3, "days_guaranteed": 1.3, "capacity_ok": True, "power_ok": True,
                      "capex": 6000.0, "investment": 6000.0}}
DISPATCH = {"production_kwh": 9000, "load_kwh": 4000, "assumed_consumption": True, "capacity_kwh": 10.0,
            "without": {"self_kwh": 1500, "export_kwh": 7500, "import_kwh": 2500, "self_consumption_pct": 16.7, "autarky_pct": 37.5},
            "with": {"self_kwh": 3000, "export_kwh": 6000, "import_kwh": 1000, "self_consumption_pct": 33.3, "autarky_pct": 75.0}}
FINANCE = {"extra_investment": 6000.0, "first_year_gain": 450.0, "payback_years": 13.3, "npv_gain": 820.0}
ROWS = [{"key": "fridge", "name": "Ψυγείο", "kwh_day": 1.2, "peak_w": 150, "on": True},
        {"key": "tv", "name": "Τηλεόραση", "kwh_day": 0.5, "peak_w": 100, "on": False}]


def with_battery(project, dispatch=False, fin=False, result=True):
    p = copy.deepcopy(project)
    p["battery"] = {"enabled": True, "rows": ROWS, "inputs": {"batCap": "10"}}
    if result:
        p["battery"]["result"] = copy.deepcopy(RESULT)
    if dispatch:
        p["battery"]["dispatch"] = copy.deepcopy(DISPATCH)
    if fin:
        p["finance"] = {**(p.get("finance") or {}), "battery": dict(FINANCE)}
    return p


def electrical_project():
    p = make_project()
    p["electrical"] = {"design": design(MODULE, p["layout"]["count"], phases="1")}
    return p


def drawn(fn, *args, **kw) -> str:
    """All the text a document builder draws, as one string (the PDF itself is compressed)."""
    seen = []
    orig = textobject.PDFTextObject._formatText

    def spy(self, text):
        seen.append(text)
        return orig(self, text)

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(textobject.PDFTextObject, "_formatText", spy)
        fn(*args, **kw)
    finally:
        mp.undo()
    return re.sub(r"\s+", " ", " ".join(seen))


def rep(p, **kw):
    return drawn(report.build_pdf, p, imagery=False, **kw)


def test_no_battery_changes_nothing():
    base = make_project()
    for p in (base, {**base, "battery": {"enabled": False, "result": RESULT}}, {**base, "battery": None},
              {**base, "battery": "oops"}):
        assert battery_report.facts(p) is None and battery_report.label(p) is None
        assert battery_report.mobile_summary(p) is None
    names = lambda p: [fn.__name__ for _, fn in report.SECTIONS if fn(report.ReportContext(p, imagery=False))]  # noqa: E731
    assert "battery_section" not in names(base)
    assert "battery_section" not in names({**base, "battery": {"enabled": False, "result": RESULT}})


def test_facts_are_tolerant():
    for dispatch, fin in ((False, False), (True, False), (False, True), (True, True)):
        f = battery_report.facts(with_battery(make_project(), dispatch, fin))
        assert f["capacity_kwh"] == 10 and bool(f["dispatch"]) == dispatch and bool(f["finance"]) == fin
    # nothing but the typed capacity (text, with a Greek comma)
    p = make_project(battery={"enabled": True, "inputs": {"batCap": "7,5"}})
    f = battery_report.facts(p)
    assert f["capacity_kwh"] == 7.5 and f["power_kw"] is None and f["usable_kwh"] is None
    # enabled but no capacity anywhere
    assert battery_report.facts(make_project(battery={"enabled": True, "inputs": {"batCap": ""}})) is None
    # garbage inside
    assert battery_report.facts(make_project(battery={"enabled": True, "result": {"battery": "x"},
                                                      "dispatch": {"without": 3}, "rows": [5, None]},
                                             finance={"battery": 3})) is None


@pytest.mark.parametrize("dispatch,fin", [(False, False), (True, False), (True, True), (False, True)])
def test_report_section(dispatch, fin):
    p = with_battery(make_project(), dispatch, fin)
    t = rep(p)
    assert "Αποθήκευση ενέργειας (μπαταρία)" in t and "Χωρητικότητα μπαταρίας" in t and "10,0 kWh" in t
    assert "Ψυγείο" in t and "Τηλεόραση" not in t
    assert ("Εξοικονόμηση με τη μπαταρία" in t) == dispatch and ("Αυτάρκεια" in t) == dispatch
    assert ("Οικονομικά της μπαταρίας" in t) == fin
    if fin:
        assert "13,3" in t and "820" in t
    assert "ενδεικτικές" in t


def test_report_section_english():
    p = with_battery(make_project(), True, True)
    p["name"] = "House"
    p["report_info"] = {"client": "George", "address": "Ermou 1, Athens", "author": "Company"}
    p["battery"]["rows"] = [{**ROWS[0], "name": "Fridge"}]
    t = rep(p, lang="en")
    assert "Energy storage (battery)" in t and "Battery capacity" in t and "10.0 kWh" in t
    assert "Savings with the battery" in t and "Battery finances" in t and "Without battery" in t
    assert not re.search(r"[Ͱ-Ͽ]", t), re.findall(r"\S*[Ͱ-Ͽ]\S*", t)


def test_report_without_battery_is_the_same_text():
    base = make_project()
    assert rep(base) == rep({**base, "battery": {"enabled": False}})


def test_single_line_with_and_without_battery():
    p = electrical_project()
    plain = drawn(single_line.build_single_line_pdf, p)
    assert "Μπαταρία" not in plain
    assert drawn(single_line.build_single_line_pdf, {**p, "battery": {"enabled": False, "result": RESULT}}) == plain
    t = drawn(single_line.build_single_line_pdf, with_battery(p))
    assert "Μπαταρία 10,0 kWh" in t and "5,0 kW" in t
    assert "Battery 10.0 kWh" in drawn(single_line.build_single_line_pdf, with_battery(p), "en")


def test_tech_description():
    p = electrical_project()
    t0 = drawn(tech_description.build_tech_description_pdf, p)
    assert "Σύστημα αποθήκευσης" not in t0 and "6. Χωροθέτηση" in t0
    t = drawn(tech_description.build_tech_description_pdf, with_battery(p))
    assert "6. Σύστημα αποθήκευσης (μπαταρία)" in t and "10,0 kWh" in t and "7. Χωροθέτηση" in t
    assert "Energy storage system" in drawn(tech_description.build_tech_description_pdf, with_battery(p), "en")


def test_appendix_i():
    p = electrical_project()
    t0 = drawn(appendix_i.build_appendix_i_pdf, p)
    assert "χωρίς αποθήκευση" in t0
    t = drawn(appendix_i.build_appendix_i_pdf, with_battery(p))
    assert "2. Σύστημα αποθήκευσης" in t and "Χωρητικότητα (kWh)" in t and "χωρίς αποθήκευση" not in t


def test_mobile_summary_and_api():
    s = battery_report.mobile_summary(with_battery(make_project(), dispatch=True))
    assert s["capacity_kwh"] == 10 and s["self_consumption_with_pct"] == 33.3 and s["self_consumption_without_pct"] == 16.7
    s = battery_report.mobile_summary(with_battery(make_project()))
    assert "self_consumption_with_pct" not in s


def test_mobile_project_gets_battery_key_only_with_a_battery(monkeypatch):
    from backend import mobile, storage
    base = {**make_project(), "id": "p1"}
    store = {"plain": base, "bat": with_battery(base, dispatch=True)}
    monkeypatch.setattr(storage, "get_project", lambda pid: store[pid])
    assert "battery" not in mobile.project("plain", "t")
    assert mobile.project("bat", "t")["battery"]["capacity_kwh"] == 10
