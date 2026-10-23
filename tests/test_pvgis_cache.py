import json

import pytest

from backend import energy, simulation


def _fake_response(payload):
    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return payload

    return R()


@pytest.fixture
def fake_pvgis(monkeypatch, tmp_path):
    monkeypatch.setattr(energy, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(energy, "RETRY_BACKOFF", 0)
    monkeypatch.setattr(energy, "parse_pvgis", lambda data, kwp, loss=None: {"source": "PVGIS", "annual_kwh": 123.0})
    return tmp_path


def test_pvcalc_cache_hit_has_notice(monkeypatch, fake_pvgis):
    monkeypatch.setattr(energy.httpx, "get", lambda *a, **k: _fake_response({}))
    energy.pvgis_estimate(38.0, 23.7, 5, 30, 180, 14)
    monkeypatch.setattr(energy.httpx, "get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("403")))
    res = energy.pvgis_estimate(38.0001, 23.7002, 5, 30, 180, 14)  # rounds to the same 3 decimals
    assert res["annual_kwh"] == 123.0 and res["notice"]


def test_pvcalc_one_retry_only_and_short_timeout(monkeypatch, fake_pvgis):
    calls = []

    def boom(url, params, timeout):
        calls.append(timeout)
        raise RuntimeError("403")

    monkeypatch.setattr(energy.httpx, "get", boom)
    with pytest.raises(RuntimeError):
        energy.pvgis_estimate(38.0, 23.7, 5, 30, 180, 14)
    assert calls == [energy.PVGIS_TIMEOUT] * 2 and energy.PVGIS_TIMEOUT <= 5


def test_weather_cache_first_no_internet(monkeypatch, tmp_path):
    monkeypatch.setattr(simulation, "WEATHER_DIR", tmp_path)
    saved = {"outputs": {"tmy_hourly": []}}
    (tmp_path / "tmy_38.00_23.70.json").write_text(json.dumps(saved), encoding="utf-8")
    monkeypatch.setattr(simulation, "parse_pvgis_tmy", lambda raw: "WEATHER")

    def boom(*a, **k):
        raise AssertionError("internet must not be asked")

    monkeypatch.setattr(simulation, "fetch_pvgis_tmy", boom)
    assert simulation.get_weather(38.0, 23.7) == ("WEATHER", "PVGIS TMY", None)


def test_weather_timeout_is_short():
    import inspect

    assert inspect.signature(simulation.fetch_pvgis_tmy).parameters["timeout"].default <= 5
