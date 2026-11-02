"""Battery sizes from the sweep and the outage table (backend/battery_plan.py), and their API."""
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend import battery, simulation
from backend import battery_plan as bp
from backend import battery_sim as bs
from backend import main
from backend.battery import BatteryParams
from backend.main import app

client = TestClient(app)
LAT, LON = 37.98, 23.72
SIM = {"lat": LAT, "lon": LON, "tilt_deg": 30, "azimuth_deg": 180, "dc_kwp": 8, "ac_kw": 6.5}
LOAD = bs.LoadParams(annual_kwh=6000)
CHEAP = dict(reserve_pct=0, cost_per_kwh=300, replacement_year=0)      # a battery that pays back
DEAR = dict(reserve_pct=0, cost_per_kwh=5000)                          # one that does not


@pytest.fixture(scope="module")
def pv():
    res = simulation.simulate(LAT, LON, 30, 180, 8.0, 6.5, weather=simulation.clearsky_weather(LAT, LON), hourly=True)
    return res.pop("_hourly_kwh")


def fin(**kw):
    return {**main.FinanceSettings(**kw).model_dump(), "kwp": 8.0}


def propose(pv, battery_kw, finance_kw=None, load=LOAD, daily=5.0, peak=3.0, days=1.0):
    return bp.propose(pv, LAT, LON, load, BatteryParams(**battery_kw), fin(**(finance_kw or {})), daily, peak, days)


@pytest.fixture(scope="module")
def cheap(pv):
    return propose(pv, CHEAP, dict(retail_price=0.25, export_price=0.04))


@pytest.fixture(scope="module")
def dear(pv):
    return propose(pv, DEAR)


def card(out, kind):
    return next(c for c in out["cards"] if c["kind"] == kind)


def test_the_finance_request_is_the_settings_plus_the_system():
    assert set(main.FinanceRequest.model_fields) == set(main.FinanceSettings.model_fields) | {"kwp", "annual_kwh", "battery"}


def test_sweep_sizes_start_at_zero_and_grow_with_the_consumption():
    for daily in (5, 16.4, 33, 400, 1e9):
        caps = bp.sweep_capacities(daily)
        assert caps[0] == 0 and caps == sorted(set(caps)) and 2 <= len(caps) <= bp.SWEEP_POINTS + 1
        assert caps[-1] >= min(max(bp.SWEEP_MIN_TOP_KWH, bp.SWEEP_DAYS * daily), bp.SWEEP_MAX_KWH) - 1e-9
        assert caps[-1] <= bp.SWEEP_MAX_KWH
    assert bp.sweep_capacities(5)[-1] == 10 and bp.sweep_capacities(16.4)[:3] == [0, 1, 2]
    assert bp.sweep_capacities(400)[1] >= 10


def test_every_size_is_what_the_finance_step_shows_for_it(monkeypatch):
    monkeypatch.setattr(simulation, "get_weather", lambda lat, lon: (simulation.clearsky_weather(lat, lon), "offline", "test"))
    main._hourly_pv.cache_clear()
    settings = {"retail_price": 0.25, "export_price": 0.04}
    battery_set = {"reserve_pct": 0, "cost_per_kwh": 300, "fade_pct_per_year": 3, "replacement_year": 10, "cost_fixed": 500, "subsidy_eur": 700}
    body = {"simulation": SIM, "load": {"annual_kwh": 6000, "profile": "home_day", "season": "summer"}, "battery": battery_set,
            "finance": settings, "loads": [{"kwh_day": 5, "peak_w": 3000}]}
    plan = client.post("/api/battery/proposals", json=body).json()
    for row in (plan["sweep"][1], plan["sweep"][5], card(plan, "eco")):
        fin_body = {"kwp": 8, "annual_kwh": 11000, **settings,
                    "battery": {"simulation": SIM, "load": body["load"], "battery": {**battery_set, "capacity_kwh": row["capacity_kwh"]}}}
        g = client.post("/api/finance", json=fin_body).json()["battery"]
        assert g["npv_gain"] == row["npv_gain"] and g["payback_years"] == row["payback_years"]
        assert g["first_year_gain"] == row["first_year_gain"] and g["investment"] == row["investment"]
        assert g["self_consumption_with_pct"] == row["self_consumption_pct"] and g["autarky_with_pct"] == row["autarky_pct"]


def test_the_sweep_is_ordered_and_a_bigger_battery_covers_more(cheap):
    caps = [r["capacity_kwh"] for r in cheap["sweep"]]
    assert caps == sorted(caps) and caps[0] == 0 and cheap["sweep"][0]["npv_gain"] == 0 and cheap["sweep"][0]["investment"] == 0
    assert cheap["base"]["autarky_pct"] == cheap["sweep"][0]["autarky_pct"]
    autarky = [r["autarky_pct"] for r in cheap["sweep"]]
    self_use = [r["self_consumption_pct"] for r in cheap["sweep"]]
    assert all(b >= a - 1e-9 for a, b in zip(autarky, autarky[1:])) and all(b >= a - 1e-9 for a, b in zip(self_use, self_use[1:]))
    assert autarky[-1] > cheap["base"]["autarky_pct"] + 30
    assert [round(r["capacity_kwh"] * 300) for r in cheap["sweep"]] == [r["investment"] for r in cheap["sweep"]]


def test_the_economic_card_is_the_size_with_the_largest_gain(cheap):
    eco = card(cheap, "eco")
    sizes = [r for r in cheap["sweep"] if r["capacity_kwh"] >= battery.MIN_CARD_KWH]
    assert eco["npv_gain"] == max(r["npv_gain"] for r in sizes) > 0
    assert eco["payback_years"] is not None and 0 < eco["payback_years"] < 25
    assert 2.5 < eco["capacity_kwh"] < sizes[-1]["capacity_kwh"]               # a middle size, not the smallest or the largest tried


def test_when_nothing_pays_the_card_says_so_with_the_least_bad_size(dear):
    eco = card(dear, "eco_no")
    sizes = [r for r in dear["sweep"] if r["capacity_kwh"] >= battery.MIN_CARD_KWH]
    assert all(c["kind"] != "eco" for c in dear["cards"])
    assert eco["npv_gain"] == max(r["npv_gain"] for r in sizes) < 0 and eco["payback_years"] is None
    assert eco["capacity_kwh"] == sizes[0]["capacity_kwh"]                      # the smaller the less it loses


def test_the_settings_of_the_user_apply_to_every_size_and_card(pv):
    out = propose(pv, {**CHEAP, "power_kw": 3.0, "cost_fixed": 400, "subsidy_eur": 100, "roundtrip_pct": 85, "usable_pct": 80})
    assert all(r["power_kw"] == 3.0 for r in out["sweep"]) and all(c["power_kw"] == 3.0 for c in out["cards"])
    assert all(r["investment"] == round(max(r["capacity_kwh"] * 300 + 400 - 100, 0), 2) for r in out["sweep"][1:])
    assert all(c["usable_kwh"] == round(c["capacity_kwh"] * 0.8, 2) for c in out["cards"])
    auto = propose(pv, CHEAP)
    assert all(abs(c["power_kw"] - 0.5 * c["capacity_kwh"]) < 0.01 for c in auto["cards"])
    # the consumption the user gave decides the sizes
    more = propose(pv, CHEAP, load=bs.LoadParams(annual_kwh=12000))
    assert more["consumption_kwh"] == 12000 and not more["assumed_consumption"] and more["sweep"][-1]["capacity_kwh"] > auto["sweep"][-1]["capacity_kwh"]
    assumed = propose(pv, CHEAP, load=bs.LoadParams())
    assert assumed["assumed_consumption"] and abs(assumed["consumption_kwh"] - assumed["production_kwh"]) < 1


def test_the_evening_card_holds_the_consumption_of_the_dark_hours(pv, cheap):
    night = card(cheap, "night")
    load_a, annual, _ = bs.load_for(pv, LAT, LON, LOAD)
    kwh = bp.night_kwh_per_day(pv.to_numpy(), load_a)
    assert abs(cheap["night_kwh_day"] - kwh) < 0.01 and 0.3 * annual / 365 < kwh < 0.7 * annual / 365
    need = bp.night_capacity_kwh(kwh, BatteryParams(**CHEAP))
    assert abs(night["needed_kwh"] - need) < 0.01 and not night["above_sweep"]
    assert need - 1e-9 <= night["capacity_kwh"] < need + 1.0 + 1e-9                  # the next size of the sweep
    # a part kept as a reserve is not free for the evening: the size grows by 1 / (1 - reserve)
    assert abs(bp.night_capacity_kwh(kwh, BatteryParams(reserve_pct=50)) - 2 * bp.night_capacity_kwh(kwh, BatteryParams(reserve_pct=0))) < 1e-9
    assert card(propose(pv, {**CHEAP, "reserve_pct": 50}), "night")["capacity_kwh"] > night["capacity_kwh"]


def test_the_evening_card_says_when_no_size_tried_is_enough(pv):
    out = propose(pv, {**CHEAP, "reserve_pct": 95})                            # only 5 % of the battery is free for the evening
    night = card(out, "night")
    assert night["above_sweep"] and night["capacity_kwh"] == out["sweep"][-1]["capacity_kwh"] and night["needed_kwh"] > night["capacity_kwh"]


def test_the_autarky_card_is_the_smallest_with_ninety_percent_of_the_rise(cheap):
    c = card(cheap, "autarky")
    rows = [r for r in cheap["sweep"] if r["capacity_kwh"] >= battery.MIN_CARD_KWH]
    base = cheap["base"]["autarky_pct"]
    top = max(r["autarky_pct"] for r in rows) - base
    assert c["autarky_pct"] - base >= 0.9 * top - 1e-9 and abs(c["autarky_gain_pct"] - (c["autarky_pct"] - base)) < 0.06
    smaller = [r for r in rows if r["capacity_kwh"] < c["capacity_kwh"]]
    assert all(r["autarky_pct"] - base < 0.9 * top for r in smaller)


def test_cards_carry_the_days_of_the_loads_to_keep(cheap):
    for c in cheap["cards"]:
        assert c["days_full"] is not None and c["days_full"] > 0
        assert abs(c["days_full"] - c["usable_kwh"] * 0.9 ** 0.5 / 5.0) < 0.01     # 5 kWh a day, 90 % round trip
        assert c["power_ok"] == (3.0 <= c["power_kw"]) and isinstance(c["capacity_ok"], bool)


def test_a_battery_that_only_waits_for_an_outage_has_nothing_to_propose(pv):
    for reserve in (100, 100.0):
        out = propose(pv, {"reserve_pct": reserve})
        assert out["savings"] is False and out["cards"] == [] and out["sweep"] == []
    assert propose(pv, {"reserve_pct": 99})["savings"] is True


def test_net_metering_values_the_battery_less(pv):
    billing = propose(pv, CHEAP, dict(retail_price=0.25, export_price=0.04))["cards"][0]
    metering = propose(pv, CHEAP, dict(scheme="net_metering", retail_price=0.25, offset_price=0.20))["cards"][0]
    assert billing["kind"] == "eco" and metering["kind"] == "eco_no"            # the grid already works like a battery
    assert metering["npv_gain"] < billing["npv_gain"]


# ---------------------------------------------------------------- outage with sun
def no_sun(pv):
    return pd.Series(np.zeros(len(pv)), index=pv.index)


def outage(pv, battery_kw, daily=3.5, profile="home", sun=True):
    series = pv if sun else no_sun(pv)
    return bp.outage_by_month(series, LAT, LON, bs.LoadParams(annual_kwh=6000, profile=profile), BatteryParams(**battery_kw), daily)


def test_without_any_sun_the_outage_is_the_closed_form_of_the_autonomy_step(pv):
    for battery_kw in ({"capacity_kwh": 10, "reserve_pct": 100}, {"capacity_kwh": 10, "reserve_pct": 40}, {"capacity_kwh": 4, "usable_pct": 80}):
        out = outage(pv, battery_kw, profile="flat", sun=False)
        b = BatteryParams(**battery_kw)
        ev = battery.evaluate(3.5, 1.0, b.capacity_kwh, 5.0, b, 1)
        expected = min(ev["days_guaranteed"], bp.OUTAGE_MAX_DAYS)
        assert len(out["months"]) == 12
        for m in out["months"]:
            assert abs(m["min_days"] - expected) < 0.01 and abs(m["mean_days"] - expected) < 0.01 and m["full_pct"] == 0
        assert out["start_kwh"] == round(b.capacity_kwh * b.usable_pct / 100 * b.reserve_pct / 100, 2)


def test_the_sun_makes_the_outage_longer_and_winter_is_the_hard_season(pv):
    sunny = outage(pv, {"capacity_kwh": 5, "reserve_pct": 100}, daily=12.0)
    dark = outage(pv, {"capacity_kwh": 5, "reserve_pct": 100}, daily=12.0, sun=False)
    for a, b in zip(sunny["months"], dark["months"]):
        assert a["min_days"] >= b["min_days"] - 1e-9 and a["mean_days"] >= b["mean_days"] - 1e-9 and a["min_days"] <= a["mean_days"] + 1e-9
    by_month = {m["month"]: m for m in sunny["months"]}
    assert by_month[12]["min_days"] < by_month[7]["min_days"] and sunny["worst_month"] in (11, 12, 1, 2)
    assert sunny["min_days"] == min(m["min_days"] for m in sunny["months"])


def test_a_bigger_battery_and_a_higher_reserve_last_longer(pv):
    small = outage(pv, {"capacity_kwh": 5, "reserve_pct": 100}, daily=12.0)
    large = outage(pv, {"capacity_kwh": 10, "reserve_pct": 100}, daily=12.0)
    low = outage(pv, {"capacity_kwh": 5, "reserve_pct": 30}, daily=12.0)
    for s, l, r in zip(small["months"], large["months"], low["months"]):
        assert l["mean_days"] >= s["mean_days"] - 1e-9 >= r["mean_days"] - 1e-9
    assert outage(pv, {"capacity_kwh": 10, "reserve_pct": 100}, daily=24.0)["min_days"] < large["min_days"]   # twice the loads


def test_a_strong_sun_never_ends_the_outage_and_the_answer_stops_at_the_limit(pv):
    big = pd.Series(pv.to_numpy() * 20, index=pv.index)                 # solar power far above the loads, every day
    out = bp.outage_by_month(big, LAT, LON, LOAD, BatteryParams(capacity_kwh=10, reserve_pct=100), 3.5)
    assert all(m["min_days"] == m["mean_days"] == bp.OUTAGE_MAX_DAYS and m["full_pct"] == 100 for m in out["months"])
    full = outage(pv, {"capacity_kwh": 500, "reserve_pct": 100}, daily=3.5, sun=False)    # 500 kWh without sun: far above 30 days
    assert all(m["min_days"] == bp.OUTAGE_MAX_DAYS for m in full["months"])


def test_without_a_battery_the_loads_run_only_while_the_sun_covers_them(pv):
    out = outage(pv, {"capacity_kwh": 0, "reserve_pct": 100})
    assert out["min_days"] == 0 and out["usable_kwh"] == 0
    assert all(0 < m["mean_days"] < 0.5 for m in out["months"])


def test_no_loads_means_nothing_to_keep_and_no_end(pv):
    out = outage(pv, {"capacity_kwh": 5, "reserve_pct": 0}, daily=0.0)
    assert out["daily_kwh"] == 0 and all(m["min_days"] == bp.OUTAGE_MAX_DAYS for m in out["months"])


# ---------------------------------------------------------------- the API
def _offline(monkeypatch):
    monkeypatch.setattr(simulation, "get_weather", lambda lat, lon: (simulation.clearsky_weather(lat, lon), "offline", "test"))
    main._hourly_pv.cache_clear()


def test_api_proposals_answer_and_reuse_the_simulation(monkeypatch):
    _offline(monkeypatch)
    body = {"simulation": SIM, "load": {"annual_kwh": 6000}, "battery": {"reserve_pct": 0, "cost_per_kwh": 300},
            "finance": {"retail_price": 0.25, "export_price": 0.04}, "loads": [{"kwh_day": 5, "peak_w": 3000}], "target_days": 2}
    r = client.post("/api/battery/proposals", json=body)
    assert r.status_code == 200
    j = r.json()
    assert j["savings"] and [c["kind"] for c in j["cards"]] == ["eco", "night", "autarky"] and j["source"] == "offline" and j["warning"] == "test"
    assert j["sweep"][0]["capacity_kwh"] == 0 and len(j["sweep"]) > 10
    before = main._hourly_pv.cache_info().hits
    client.post("/api/battery/proposals", json=body)
    client.post("/api/battery/outage", json={"simulation": SIM, "load": {"annual_kwh": 6000}, "battery": {"capacity_kwh": 5}})
    assert main._hourly_pv.cache_info().hits == before + 2                    # the simulation is not run again
    # nothing to propose for a pure backup battery (the default reserve is 100 %)
    backup = client.post("/api/battery/proposals", json={"simulation": SIM}).json()
    assert backup["savings"] is False and backup["cards"] == []
    assert client.post("/api/battery/proposals", json={**body, "simulation": {**SIM, "dc_kwp": 0}}).status_code == 422
    assert client.post("/api/battery/proposals", json={**body, "finance": {"retail_price": -1}}).status_code == 422
    assert client.post("/api/battery/proposals", json={}).status_code == 422


def test_api_outage_per_month(monkeypatch):
    _offline(monkeypatch)
    body = {"simulation": SIM, "load": {"annual_kwh": 6000, "profile": "always_on"}, "battery": {"capacity_kwh": 5, "reserve_pct": 50},
            "loads": [{"kwh_day": 4, "peak_w": 500}, {"kwh_day": 8, "peak_w": 1000}]}
    r = client.post("/api/battery/outage", json=body)
    assert r.status_code == 200
    j = r.json()
    assert j["daily_kwh"] == 12 and j["capacity_kwh"] == 5 and j["max_days"] == 30 and [m["month"] for m in j["months"]] == list(range(1, 13))
    assert j["source"] == "offline" and j["start_kwh"] == round(5 * 0.9 * 0.5, 2) and j["worst_month"] in range(1, 13)
    assert client.post("/api/battery/outage", json={**body, "battery": {"capacity_kwh": -1}}).status_code == 422
    assert client.post("/api/battery/outage", json={**body, "load": {"profile": "nonsense"}}).status_code == 422


def test_an_existing_system_is_scaled_to_its_real_yearly_production(monkeypatch):
    _offline(monkeypatch)
    plain = client.post("/api/battery/simulate", json={"simulation": SIM, "load": {"annual_kwh": 6000}, "battery": {"capacity_kwh": 5}}).json()
    real = {**SIM, "target_annual_kwh": 9000}
    r = client.post("/api/battery/simulate", json={"simulation": real, "load": {"annual_kwh": 6000}, "battery": {"capacity_kwh": 5}})
    assert r.status_code == 200
    j = r.json()
    assert abs(j["production_kwh"] - 9000) < 1 and abs(plain["production_kwh"] - 9000) > 100
    # the shape of the hours stays: every month keeps its share of the year
    share = lambda d: [m["production_kwh"] / d["production_kwh"] for m in d["monthly"]]
    assert all(abs(a - b) < 1e-3 for a, b in zip(share(j), share(plain)))
    assert client.post("/api/battery/simulate", json={"simulation": {**SIM, "target_annual_kwh": 0}}).status_code == 422
