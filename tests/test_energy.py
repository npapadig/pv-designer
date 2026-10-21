from backend import energy

SAMPLE_PVGIS = {
    "outputs": {
        "monthly": {"fixed": [{"month": m, "E_m": 500.0 + m, "H(i)_m": 150.0} for m in range(1, 13)]},
        "totals": {"fixed": {"E_y": 6078.0, "H(i)_y": 1800.0, "l_total": -20.1}},
    }
}


def test_parse_pvgis():
    res = energy.parse_pvgis(SAMPLE_PVGIS, 4.0)
    assert res["source"] == "PVGIS"
    assert res["annual_kwh"] == 6078
    assert res["specific_yield"] == 1520
    assert len(res["monthly"]) == 12


def test_offline_estimate_plausible_for_athens():
    res = energy.offline_estimate(37.98, 23.72, 10.0, 30, 180, 14)
    # Real-world yield in Athens is ~1400-1600 kWh/kWp; the rough model should be in the same range.
    assert 1100 < res["specific_yield"] < 1900
    summer = res["monthly"][6]["kwh"]
    winter = res["monthly"][0]["kwh"]
    assert summer > winter


def test_auto_falls_back_when_pvgis_unreachable(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("offline")
    monkeypatch.setattr(energy, "pvgis_estimate", boom)
    res = energy.estimate(37.98, 23.72, 5.0, 30, 180, 14, "auto")
    assert res["source"] == "offline"
    assert "warning" in res


def test_parse_pvgis_losses():
    data = {"outputs": {**SAMPLE_PVGIS["outputs"], "totals": {"fixed": {
        **SAMPLE_PVGIS["outputs"]["totals"]["fixed"], "l_aoi": -2.5, "l_spec": 0.8, "l_tg": -7.9}}}}
    res = energy.parse_pvgis(data, 4.0, 14)
    assert res["losses"] == {"aoi": 2.5, "spectral": -0.8, "temperature": 7.9, "system": 14}


def test_parse_pvgis_numbers_as_text():
    # PVGIS has started sending some totals as text (seen 2026-10-21: l_spec "0.46").
    data = {"outputs": {**SAMPLE_PVGIS["outputs"], "totals": {"fixed": {
        **SAMPLE_PVGIS["outputs"]["totals"]["fixed"], "l_aoi": "-2.5", "l_spec": "0.8", "l_tg": "-7.9"}}}}
    res = energy.parse_pvgis(data, 4.0, 14)
    assert res["losses"] == {"aoi": 2.5, "spectral": -0.8, "temperature": 7.9, "system": 14}
    assert res["annual_kwh"] == 6078
