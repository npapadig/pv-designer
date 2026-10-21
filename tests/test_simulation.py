
from backend import simulation


def _weather():
    return simulation.clearsky_weather(37.98, 23.72)


def test_simulation_plausible_and_losses_add_up():
    r = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 8.0, weather=_weather())
    assert 1100 < r["specific_yield"] < 1900
    assert 0.7 < r["performance_ratio"] < 0.95
    assert len(r["monthly"]) == 12
    lost = sum(l["kwh"] for l in r["loss_steps"])
    assert abs(r["nominal_kwh"] - lost - r["annual_kwh"]) < 15
    assert {l["key"] for l in r["loss_steps"]} >= {"temperature", "inverter", "clipping", "dc_wiring"}


def test_small_inverter_clips_more():
    w = _weather()
    big = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 10.0, weather=w)
    small = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 5.0, weather=w)
    clip = lambda r: next(l["kwh"] for l in r["loss_steps"] if l["key"] == "clipping")
    assert clip(small) > clip(big)
    assert small["annual_kwh"] < big["annual_kwh"]


def test_flush_mount_runs_hotter():
    w = _weather()
    rack = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 8.0, mounting="rack", weather=w)
    flush = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 8.0, mounting="flush", weather=w)
    assert flush["max_cell_temp"] > rack["max_cell_temp"]
    assert flush["annual_kwh"] < rack["annual_kwh"]


def _fake_tmy():
    w = _weather()
    rows = [{
        "time(UTC)": t.strftime("2015%m%d:%H%M"), "T2m": row.temp_air, "RH": 50, "G(h)": row.ghi,
        "Gb(n)": row.dni, "Gd(h)": row.dhi, "IR(h)": 300, "WS10m": 2, "WD10m": 0, "SP": 101000,
    } for t, row in w.iterrows()]
    return {"outputs": {"tmy_hourly": rows}}


def test_parse_pvgis_tmy():
    df = simulation.parse_pvgis_tmy(_fake_tmy())
    assert len(df) == 8760
    assert df.index.tz is not None
    assert {"ghi", "dni", "dhi", "temp_air", "wind_speed"} <= set(df.columns)


def test_weather_cache_used_when_offline(tmp_path, monkeypatch):
    monkeypatch.setattr(simulation, "WEATHER_DIR", tmp_path)
    monkeypatch.setattr(simulation, "fetch_pvgis_tmy", lambda *a, **k: _fake_tmy())
    _, src, warn = simulation.get_weather(38.0, 23.7)
    assert src == "PVGIS TMY" and warn is None

    def boom(*a, **k):
        raise RuntimeError("offline")
    monkeypatch.setattr(simulation, "fetch_pvgis_tmy", boom)
    _, src, warn = simulation.get_weather(38.0, 23.7)
    assert src == "PVGIS TMY" and warn is None  # served from the saved copy
    _, src, warn = simulation.get_weather(40.6, 22.9)
    assert src == "offline" and warn


def test_shading_loss_is_a_step():
    w = _weather()
    clear = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 8.0, weather=w)
    shaded = simulation.simulate(37.98, 23.72, 30, 180, 10.0, 8.0, weather=w, shading_monthly_pct=[10] * 12)
    step = next(l for l in shaded["loss_steps"] if l["key"] == "shading")
    assert abs(step["pct"] - 10) < 0.01
    assert shaded["losses"]["shading"] == step["pct"]
    assert 0.85 < shaded["annual_kwh"] / clear["annual_kwh"] < 0.95
    assert not any(l["key"] == "shading" for l in clear["loss_steps"])
