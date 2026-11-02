"""Hourly battery model (backend/battery_sim.py), its use in the finance analysis and the API."""
import math

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend import battery_sim as bs
from backend import finance, main, simulation
from backend.battery import BatteryParams
from backend.main import app

client = TestClient(app)
LAT, LON = 37.98, 23.72


@pytest.fixture(scope="module")
def weather():
    return simulation.clearsky_weather(LAT, LON)


@pytest.fixture(scope="module")
def pv(weather):
    res = simulation.simulate(LAT, LON, 30, 180, 8.0, 6.5, weather=weather, hourly=True)
    return res.pop("_hourly_kwh")


def test_hourly_flag_adds_the_series_and_changes_nothing_else(weather):
    plain = simulation.simulate(LAT, LON, 30, 180, 8.0, 6.5, weather=weather)
    hourly = simulation.simulate(LAT, LON, 30, 180, 8.0, 6.5, weather=weather, hourly=True)
    series = hourly.pop("_hourly_kwh")
    assert hourly == plain and len(series) == 8760 and abs(series.sum() - plain["annual_kwh"]) < 1.0


def test_load_profile_keeps_the_total_and_the_local_hours(pv):
    load = bs.hourly_load(pv.index, 6000, "home", "mixed", LAT, LON)
    assert abs(load.sum() - 6000) < 1e-6 and (load > 0).all()
    s = pd.Series(load, index=pv.index)
    # the evening peak of the "home" shape is at local hour 20: UTC+2 in winter, UTC+3 in summer
    winter = s[s.index.month == 1].groupby(s[s.index.month == 1].index.hour).mean()
    summer = s[s.index.month == 7].groupby(s[s.index.month == 7].index.hour).mean()
    assert winter.idxmax() == 18 and summer.idxmax() == 17
    # July has more load than April (the "mixed" season), in proportion to the factors
    month = s.groupby(s.index.month).sum()
    assert abs(month[7] / month[4] - (1.20 * 31) / (0.85 * 30)) < 1e-9


def test_without_a_battery_nothing_changes(pv):
    load = bs.hourly_load(pv.index, 6000, "home", "mixed", LAT, LON)
    a = bs.without_battery(pv.to_numpy(), load)
    d = bs.dispatch(pv, load, 0, 90, 90, 5, 0)
    assert abs(a["import"] - d["import"]) < 1e-6 and abs(a["export"] - d["export"]) < 1e-6 and d["cycles"] == 0


def test_energy_balance_and_limits(pv):
    load = bs.hourly_load(pv.index, 6000, "home", "mixed", LAT, LON)
    cap, usable, rt, power, reserve = 10.0, 90.0, 90.0, 3.0, 20.0
    d = bs.dispatch(pv, load, cap, usable, rt, power, reserve, series=True)
    eta = math.sqrt(rt / 100)
    cap_use = cap * usable / 100
    floor = cap_use * reserve / 100
    # all consumption is served, all production is used or sold
    assert abs(d["consumption"] - (np.minimum(pv, load).sum() + d["discharged"] + d["import"])) < 1e-6
    assert abs(d["production"] - (np.minimum(pv, load).sum() + d["charged"] + d["export"])) < 1e-6
    # what went into the battery = losses + what came out + the change of the stored energy
    stored_change = d["stored"][-1] - floor
    losses = d["charged"] * (1 - eta) + d["discharged"] * (1 / eta - 1)
    assert abs((d["charged"] - d["discharged"]) - (losses + stored_change)) < 1e-6
    assert d["stored"].min() >= floor - 1e-9 and d["stored"].max() <= cap_use + 1e-9
    assert d["charge"].max() <= power + 1e-9 and d["discharge"].max() <= power + 1e-9


def test_more_battery_means_more_self_consumption_and_less_import(pv):
    load = bs.hourly_load(pv.index, 6000, "home", "mixed", LAT, LON)
    last_imp, last_exp = None, None
    for cap in (0, 2.5, 5, 10, 20, 40):
        d = bs.dispatch(pv, load, cap, 90, 90, cap * 0.5, 0)
        if last_imp is not None:
            assert d["import"] <= last_imp + 1e-6 and d["export"] <= last_exp + 1e-6
        last_imp, last_exp = d["import"], d["export"]
    assert last_imp < bs.without_battery(pv.to_numpy(), load)["import"]


def test_a_full_reserve_is_never_used_for_saving(pv):
    load = bs.hourly_load(pv.index, 6000, "home", "mixed", LAT, LON)
    d = bs.dispatch(pv, load, 10, 90, 90, 5, 100)
    base = bs.without_battery(pv.to_numpy(), load)
    assert d["discharged"] == 0 and d["charged"] == 0 and abs(d["import"] - base["import"]) < 1e-6
    half = bs.dispatch(pv, load, 10, 90, 90, 5, 50)
    zero = bs.dispatch(pv, load, 10, 90, 90, 5, 0)
    assert zero["import"] < half["import"] < base["import"]


def test_simulate_year_reports_both_cases_months_and_days(pv):
    b = BatteryParams(capacity_kwh=10, reserve_pct=0)
    r = bs.simulate_year(pv, LAT, LON, bs.LoadParams(annual_kwh=6000), b)
    assert r["load_kwh"] == 6000 and not r["assumed_consumption"] and r["usable_kwh"] == 9.0 and r["power_kw"] == 5.0
    assert r["with"]["self_consumption_pct"] > r["without"]["self_consumption_pct"]
    assert r["with"]["autarky_pct"] > r["without"]["autarky_pct"] and 0 < r["with"]["cycles"] < 400
    assert len(r["monthly"]) == 12 and abs(sum(m["load_kwh"] for m in r["monthly"]) - 6000) < 2
    assert abs(sum(m["import_with_kwh"] for m in r["monthly"]) - r["with"]["import_kwh"]) < 2
    july = r["day_profiles"]["7"]
    assert set(july) == {"pv", "load", "charge", "discharge", "soc_pct", "import", "export"} and all(len(v) == 24 for v in july.values())
    assert max(july["pv"]) > 1 and max(july["soc_pct"]) <= 100.0 + 1e-9
    # without a given consumption it is assumed equal to the production, and says so
    assumed = bs.simulate_year(pv, LAT, LON, bs.LoadParams(), b)
    assert assumed["assumed_consumption"] and abs(assumed["load_kwh"] - assumed["production_kwh"]) < 1.0


def test_years_degrade_fade_and_replace(pv):
    b = BatteryParams(capacity_kwh=10, reserve_pct=0, fade_pct_per_year=10, replacement_year=5, cost_per_kwh=500, replacement_cost_pct=50)
    st = bs.storage_for_finance(pv, LAT, LON, bs.LoadParams(annual_kwh=6000), b, 8, 1.0)
    assert len(st["years"]) == len(st["years_without"]) == 8
    prod = [y["production"] for y in st["years"]]
    assert all(abs(prod[i + 1] / prod[i] - 0.99) < 1e-9 for i in range(7))
    imp = [y["import"] for y in st["years"]]
    assert imp[3] > imp[0]                      # a faded battery saves less
    assert imp[4] < imp[3]                      # the new one in year 5 saves more again
    assert st["replacement_year"] == 5 and st["replacement_cost"] == 2500 and st["investment"] == 5000
    # the without-case has no battery: production and consumption are the same
    assert all(abs(a["production"] - b_["production"]) < 1e-9 for a, b_ in zip(st["years"], st["years_without"]))
    none = bs.storage_for_finance(pv, LAT, LON, bs.LoadParams(annual_kwh=6000), BatteryParams(capacity_kwh=0), 3, 0.5)
    assert none["years"] == none["years_without"] and none["investment"] == 0 and none["replacement_year"] == 0


def _storage(self_kwh, export_kwh, years=25, **kw):
    flow = {"production": self_kwh + export_kwh, "self": self_kwh, "export": export_kwh, "import": 0.0}
    st = {"annual_kwh": 5000.0, "years": [dict(flow) for _ in range(years)], "years_without": [dict(flow) for _ in range(years)],
          "summary": {"with": {"self_consumption_pct": 40.0, "autarky_pct": 50.0}, "without": {"self_consumption_pct": 40.0, "autarky_pct": 50.0}},
          "capex": 0.0, "investment": 0.0, "replacement_year": 0, "replacement_cost": 0.0}
    st.update(kw)
    return st


def test_finance_with_storage_adds_the_battery_and_says_what_it_brings():
    p = dict(kwp=5, annual_kwh=7000, capex_per_kwp=1000, scheme="net_billing", retail_price=0.2, export_price=0.05,
             price_escalation_pct=0, degradation_pct=0, om_per_kwp=0, inverter_replacement_year=0, lifetime_years=20)
    base = finance.analyse(finance.FinanceParams(**p, self_consumption_pct=40, annual_consumption_kwh=5000))
    with_ = _storage(2800, 4200)
    with_["years"] = [{"production": 7000.0, "self": 4800.0, "export": 2200.0, "import": 200.0}] * 20  # the battery adds 2000 kWh
    with_.update(years_without=[{"production": 7000.0, "self": 2800.0, "export": 4200.0, "import": 2200.0}] * 20,
                 capex=4000.0, investment=3500.0, replacement_year=10, replacement_cost=2000.0)
    res = finance.analyse(finance.FinanceParams(**p, storage=with_))
    assert res["capex"] == 5000 + 4000 and res["investment"] == 5000 + 3500
    # 2000 kWh more used at 0.20 instead of sold at 0.05: +300 a year
    assert abs(res["battery"]["first_year_gain"] - 300) < 1e-6
    assert res["battery"]["extra_investment"] == 3500 and res["years"][9]["replacement"] == 2000
    # the new battery of year 10 has to be earned back too: (3500 + 2000) / 300 years
    assert abs(res["battery"]["payback_years"] - 5500 / 300) < 0.2 and res["battery"]["npv_gain"] < 0
    assert res["battery"]["self_consumption_with_pct"] == 40.0
    # without a battery nothing of this is there, and the numbers are the old ones
    assert "battery" not in base and base["years"][0]["self_kwh"] == 2800


def test_a_pure_backup_battery_is_a_cost_that_does_not_pay_back():
    p = dict(kwp=5, annual_kwh=7000, capex_per_kwp=1000, price_escalation_pct=0, degradation_pct=0, om_per_kwp=0,
             inverter_replacement_year=0, lifetime_years=15)
    st = _storage(2800, 4200, 15, capex=6000.0, investment=6000.0)
    res = finance.analyse(finance.FinanceParams(**p, storage=st))
    assert res["battery"]["first_year_gain"] == 0 and res["battery"]["payback_years"] is None and res["battery"]["npv_gain"] < -5000


def _offline(monkeypatch):
    monkeypatch.setattr(simulation, "get_weather", lambda lat, lon: (simulation.clearsky_weather(lat, lon), "offline", "test"))
    main._hourly_pv.cache_clear()


SIM = {"lat": LAT, "lon": LON, "tilt_deg": 30, "azimuth_deg": 180, "dc_kwp": 8, "ac_kw": 6.5}


def test_api_battery_simulate_and_cache(monkeypatch):
    _offline(monkeypatch)
    body = {"simulation": SIM, "load": {"annual_kwh": 6000, "profile": "home", "season": "mixed"},
            "battery": {"capacity_kwh": 10, "reserve_pct": 0}}
    r = client.post("/api/battery/simulate", json=body)
    assert r.status_code == 200
    j = r.json()
    assert j["with"]["autarky_pct"] > j["without"]["autarky_pct"] and j["source"] == "offline" and j["warning"] == "test"
    before = main._hourly_pv.cache_info().hits
    client.post("/api/battery/simulate", json=body)
    assert main._hourly_pv.cache_info().hits == before + 1       # the simulation is not run again
    assert client.post("/api/battery/simulate", json={**body, "simulation": {**SIM, "dc_kwp": 0}}).status_code == 422


def test_api_finance_with_and_without_a_battery(monkeypatch):
    _offline(monkeypatch)
    fin = {"kwp": 8, "annual_kwh": 11000, "lifetime_years": 25}
    plain = client.post("/api/finance", json=fin).json()
    assert "battery" not in plain
    battery_body = {"simulation": SIM, "load": {"annual_kwh": 6000}, "battery": {"capacity_kwh": 10, "reserve_pct": 0, "cost_per_kwh": 600}}
    r = client.post("/api/finance", json={**fin, "battery": battery_body})
    assert r.status_code == 200
    j = r.json()
    assert j["battery"]["extra_investment"] == 6000 and j["battery"]["first_year_gain"] > 0
    assert j["capex"] == plain["capex"] + 6000 and len(j["years"]) == 25
    # capacity 0 is the same as no battery
    zero = client.post("/api/finance", json={**fin, "battery": {**battery_body, "battery": {"capacity_kwh": 0}}}).json()
    assert zero == plain
