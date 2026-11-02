"""Single-line diagram (backend/single_line.py): one A4 page with the IEC-style chain, legend, protection settings,
notes and title block, for 1~ and 3~ systems, with and without a battery (DC- or AC-coupled)."""
import copy
import re

import pytest

from backend import equipment, single_line, tech_description
from backend.electrical import Module, design
from tests.test_battery_outputs import RESULT, drawn
from tests.test_report import make_project

MODULE = Module(power_w=450, voc=41.0, isc=13.9, vmp=34.5, imp=13.05)
GREEK = re.compile(r"[Ͱ-Ͽἀ-῿]")
BATTERY = {"enabled": True, "inputs": {"batCap": "10"}, "result": copy.deepcopy(RESULT),
           "rows": [{"key": "f", "name": "Fridge", "kwh_day": 1.2, "peak_w": 150, "on": True}]}


def _inv(prefix):
    return next(i for i in equipment.INVERTERS if i.name.startswith(prefix))


def project(kind: str, **kw) -> dict:
    p = make_project()
    if kind == "3ph":
        p["electrical"] = {"design": design(MODULE, 80, inverter=_inv("Τριφασικός 30"), n_inverters=1)}
    elif kind == "1ph":
        p["electrical"] = {"design": design(MODULE, 14, inverter=_inv("Μονοφασικός 5"), n_inverters=1)}
    else:  # single-phase 6 kW: above the 5 kW limit
        p["electrical"] = {"design": design(MODULE, 16, inverter=_inv("Μονοφασικός 6"), n_inverters=1)}
    p.update(kw)
    return p


def pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type /Page[^s]", pdf))


CASES = {
    "3ph": project("3ph"),
    "1ph": project("1ph"),
    "3ph_bat_dc": project("3ph", battery=copy.deepcopy(BATTERY)),
    "1ph_bat_ac": project("1ph", battery=copy.deepcopy(BATTERY), single_line={"battery_coupling": "ac"}),
}


@pytest.mark.parametrize("name", list(CASES))
def test_one_page_in_both_languages(name):
    for lang in ("el", "en"):
        pdf = single_line.build_single_line_pdf(CASES[name], lang)
        assert pdf.startswith(b"%PDF") and pages(pdf) == 1, (name, lang)


@pytest.mark.parametrize("name", list(CASES))
def test_greek_contents(name):
    t = drawn(single_line.build_single_line_pdf, CASES[name])
    for word in ("ΠΛΕΥΡΑ DC (=)", "ΠΛΕΥΡΑ AC (~)", "H1Z2Z2-K 1×6 mm²", "SPD Τύπος 2 DC", "Τύπος B",
                 "αποζεύκτης AC ΦΒ", "Γενικός πίνακας (Γ.Π.)", "Μετρητής ΔΕΔΔΗΕ", "Net billing", "Δίκτυο ΧΤ ΔΕΔΔΗΕ",
                 "Υπόμνημα συμβόλων", "Ρυθμίσεις προστασίας διασύνδεσης", "264,5 V (+15 %)", "184 V (−20 %)",
                 "3 min", "ΔΕΔΔΗΕ/ρυθμίσεις inverter", "Σημειώσεις", "διπλή τροφοδοσία", "Ασφάλειες string: όχι, εκτός αν απαιτούνται", "Τύπου B ή inverter με RCMU", "Αριθμός Παροχής",
                 "Σελίδα 1 από 1", "Όπως κατασκευάστηκε", "Ο ηλεκτρολόγος εγκαταστάτης", "Ο ιδιοκτήτης / χρήστης",
                 "ΚΖΓ", "αλεξικέραυνο", "πρέπει να ελεγχθούν και να υπογραφούν", "-Q1", "-F1", "-T1", "-P1", "-W1"):
        assert word in t, (name, word)
    assert "συμψηφισμός" not in t and re.search(r"[24]P C\d+ 6 kA", t)
    # conductor marks; the legend always shows «3/N/PE» once as an example
    assert (t.count("3/N/PE") > 1) == name.startswith("3ph") and ("L/N/PE" in t) == name.startswith("1ph")
    has_bat = "bat" in name
    assert ("Μπαταρία 10,0 kWh" in t) == has_bat and ("BMS" in t) == has_bat
    assert ("σύζευξη DC (υβριδικός inverter)" in t) == (name == "3ph_bat_dc")
    assert ("Inverter μπαταρίας" in t) == (name == "1ph_bat_ac")
    assert ("Πίνακας εφεδρείας" in t) == (name == "3ph_bat_dc")  # backup loads exist; EPS drawn for DC coupling


@pytest.mark.parametrize("name", list(CASES))
def test_english_has_no_greek(name):
    p = {**CASES[name], "name": "House",
         "report_info": {"client": "George", "address": "Ermou 1", "author": "Company", "supply_no": "12345"},
         "settings": {**CASES[name]["settings"], "panel_name": "Test 450"}}
    t = drawn(single_line.build_single_line_pdf, p, "en")
    t = t.replace("IΔn", "").replace("η ", "")  # the usual symbols of rated residual current and efficiency
    assert not GREEK.search(t), re.findall(r"\S*[Ͱ-Ͽ]\S*", t)
    assert "Page 1 of 1" in t and "As built" in t and "12345" in t and "Interface protection settings" in t


def test_single_phase_over_5kw_warning():
    assert "μονοφασική σύνδεση πάνω από 5 kW" in drawn(single_line.build_single_line_pdf, project("1ph6"))
    assert "μονοφασική σύνδεση πάνω από 5 kW" not in drawn(single_line.build_single_line_pdf, CASES["1ph"])
    assert "μονοφασική σύνδεση πάνω από 5 kW" not in drawn(single_line.build_single_line_pdf, CASES["3ph"])


def test_overrides_and_scheme():
    p = project("3ph", report_info={"supply_no": "1 23456789-01"},
                single_line={"string_fuse_a": 15, "rcd_type": "A", "ac_curve": "B", "ac_icu_ka": 10, "dc_cable": "4",
                             "ac_cable": "10", "meter_cable": "16"})
    t = drawn(single_line.build_single_line_pdf, p)
    assert "gPV 15 A" in t and "Τύπος A" in t and "B50 10 kA" in t and "H1Z2Z2-K 1×4 mm²" in t
    assert "5G10 mm²" in t and "16 mm²" in t and "1 23456789-01" in t
    assert "Ασφάλειες string: όχι" not in t
    p = project("3ph", finance={"report": {"summary": [["Τρόπος σύνδεσης", "Net metering (ενεργειακός συμψηφισμός)"]]}})
    assert "Net metering" in drawn(single_line.build_single_line_pdf, p)
    assert single_line.values(project("3ph"))["scheme"] == "net_billing"


def test_dc_ratings_come_from_the_design():
    v = single_line.values(CASES["3ph"])
    d = CASES["3ph"]["electrical"]["design"]
    assert v["vdc"] == d["inverter"]["vdc_max"] and v["idc"] >= 1.25 * d["currents"]["isc_mppt"]
    assert v["poles"] == "4P" and single_line.values(CASES["1ph"])["poles"] == "2P"


def test_tech_description_is_consistent():
    t = drawn(tech_description.build_tech_description_pdf, CASES["3ph"])
    assert "H1Z2Z2-K 1×6 mm²" in t and "Τύπος B" in t and "Net billing" in t and "SPD Τύπος 2 DC" in t
    assert "συμψηφισμός" not in t and "VDE 0126-1-1" in t
    assert not GREEK.search(drawn(tech_description.build_tech_description_pdf,
                                  {**CASES["3ph"], "name": "House", "report_info": {},
                                   "settings": {**CASES["3ph"]["settings"], "panel_name": "Test"}}, "en"))
