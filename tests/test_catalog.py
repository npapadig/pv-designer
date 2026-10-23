"""The real-product catalog (backend/catalog/*.json) must be physically sensible."""
import pytest

from backend.electrical import Module
from backend.equipment import CATALOG_INVERTERS, CATALOG_PANELS, INVERTERS, PRESET_INVERTERS


def test_catalog_not_empty_and_unique():
    assert CATALOG_PANELS and CATALOG_INVERTERS
    for items in (CATALOG_PANELS, CATALOG_INVERTERS):
        names = [i.name for i in items]
        assert len(names) == len(set(names))


@pytest.mark.parametrize("p", CATALOG_PANELS, ids=lambda p: p.name)
def test_panel_is_consistent(p):
    Module(power_w=p.power_w, voc=p.voc, isc=p.isc, vmp=p.vmp, imp=p.imp,
           temp_coeff_voc_pct=p.temp_coeff_voc_pct, temp_coeff_isc_pct=p.temp_coeff_isc_pct,
           temp_coeff_pmax_pct=p.temp_coeff_pmax_pct)
    assert p.voc > p.vmp and p.isc > p.imp
    assert p.vmp * p.imp == pytest.approx(p.power_w, rel=0.03)
    assert p.source.startswith("http") or " " in p.source


@pytest.mark.parametrize("i", CATALOG_INVERTERS, ids=lambda i: i.name)
def test_inverter_is_consistent(i):
    assert i.v_mppt_min < i.v_mppt_max <= i.vdc_max
    assert i.v_start <= i.v_mppt_max
    assert i.isc_max_mppt >= i.i_max_mppt
    assert i.pdc_max_w >= i.pac_w * 0.95
    assert 90 < i.eff_pct <= 100


def test_auto_design_uses_only_generic_inverters():
    assert len(PRESET_INVERTERS) == len(INVERTERS) + len(CATALOG_INVERTERS)
    assert not set(map(id, CATALOG_INVERTERS)) & set(map(id, INVERTERS))
