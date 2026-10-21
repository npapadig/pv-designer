import pytest

from backend.electrical import Module, design, hot_cell_temp
from backend.equipment import INVERTERS

MODULE = Module(power_w=410, voc=37.3, isc=13.9, vmp=31.0, imp=13.2)
THREE_PHASE_10KW = next(i for i in INVERTERS if i.name.startswith("Τριφασικός 10 kW"))


def test_auto_design_is_valid_and_sized():
    for n in (10, 24, 57, 120, 600):
        d = design(MODULE, n)
        assert d["ok"], d["checks"]
        assert 1.0 <= d["dc_ac_ratio"] <= 1.35
        assert d["modules_used"] == d["n_strings"] * d["modules_per_string"]
        inv = d["inverter"]
        assert d["voltages"]["voc_cold"] <= inv["vdc_max"]
        assert d["voltages"]["vmp_hot"] >= inv["v_mppt_min"]
        assert d["currents"]["isc_mppt"] <= inv["isc_max_mppt"]


def test_big_system_uses_few_large_inverters():
    d = design(MODULE, 600)  # ~246 kWp
    assert d["n_inverters"] <= 3


def test_single_phase_not_chosen_above_5kw():
    assert design(MODULE, 30)["inverter"]["phases"] == 3


def test_colder_site_allows_fewer_modules_per_string():
    mild = design(MODULE, 40, inverter=THREE_PHASE_10KW, t_min=0)["string_range"]["max"]
    cold = design(MODULE, 40, inverter=THREE_PHASE_10KW, t_min=-20)["string_range"]["max"]
    assert cold < mild


def test_too_long_string_is_an_error():
    d = design(MODULE, 40, inverter=THREE_PHASE_10KW, modules_per_string=30)
    assert not d["ok"]
    assert any(c["level"] == "error" and "τάση" in c["text"] for c in d["checks"])
    assert d["modules_unused"] == 10


def test_too_short_string_warns():
    d = design(MODULE, 40, inverter=THREE_PHASE_10KW, modules_per_string=4, n_inverters=1)
    assert any(c["level"] == "warning" and "ζέστη" in c["text"] for c in d["checks"])


def test_too_few_modules_raises():
    with pytest.raises(ValueError):
        design(MODULE, 2, inverter=THREE_PHASE_10KW)


def test_hot_cell_temperature_by_mounting():
    assert hot_cell_temp(40, "flush") > hot_cell_temp(40, "rack") > 60


def test_report_block_shape():
    rep = design(MODULE, 24)["report"]
    assert rep["summary"] and len(rep["tables"]) == 2
    assert all(len(r) == 4 for r in rep["tables"][0]["rows"])
