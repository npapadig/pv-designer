"""Battery autonomy sizing (backend/battery.py): closed-form results, cards and the API."""
import math

from fastapi.testclient import TestClient

from backend import battery
from backend.battery import AutonomyRequest, BatteryParams, LoadItem
from backend.main import app

client = TestClient(app)


def basic_loads():
    by_key = {a["key"]: a for a in battery.APPLIANCES}
    return [LoadItem(kwh_day=by_key[k]["kwh_day"], peak_w=by_key[k]["peak_w"]) for k in battery.presets()["sets"]["basic"]]


def test_load_summary_adds_energy_and_scales_the_peak():
    daily, peak = battery.load_summary([LoadItem(kwh_day=1, peak_w=1000), LoadItem(kwh_day=2, peak_w=3000)], 50)
    assert daily == 3 and abs(peak - 2.0) < 1e-9


def test_needed_capacity_and_days_are_inverse():
    b = BatteryParams(usable_pct=80, roundtrip_pct=81, reserve_pct=100)  # sqrt(0.81) = 0.9
    need = battery.needed_capacity_kwh(10, 2, b)
    assert abs(need - 20 / (0.9 * 0.8)) < 1e-9
    ev = battery.evaluate(10, 1, need, None, b, 2)
    assert abs(ev["days_full"] - 2) < 0.01 and abs(ev["days_guaranteed"] - 2) < 0.01 and ev["capacity_ok"]


def test_reserve_only_guarantees_its_part():
    b = BatteryParams(usable_pct=100, roundtrip_pct=100, reserve_pct=50)
    ev = battery.evaluate(10, 1, 40, None, b, 2)
    assert ev["days_full"] == 4 and ev["days_guaranteed"] == 2 and ev["capacity_ok"]
    assert not battery.evaluate(10, 1, 30, None, b, 2)["capacity_ok"]  # guaranteed 15 kWh = 1.5 days
    # a battery that saves money only (0 %) is judged as if it were full
    b0 = BatteryParams(usable_pct=100, roundtrip_pct=100, reserve_pct=0)
    assert battery.needed_capacity_kwh(10, 2, b0) == 20
    assert battery.evaluate(10, 1, 20, None, b0, 2)["capacity_ok"]


def test_power_check_and_automatic_power():
    b = BatteryParams()
    assert battery.auto_power_kw(10, 1.2) == 5.0           # half a kW per kWh
    assert battery.auto_power_kw(2, 3.1) == 3.5            # the loads need more: peak rounded up to 0.5
    assert battery.evaluate(5, 3, 10, None, b, 1)["power_ok"]
    low = battery.evaluate(5, 3, 10, 2.0, b, 1)
    assert not low["power_ok"] and low["power_kw"] == 2.0 and not low["power_auto"]


def test_cost_with_subsidy_and_no_battery_no_fixed_cost():
    b = BatteryParams(cost_per_kwh=500, cost_fixed=300, subsidy_eur=1000)
    assert battery.cost(10, b) == {"capex": 5300.0, "investment": 4300.0}
    assert battery.cost(0, b) == {"capex": 0.0, "investment": 0.0}


def test_cards_use_the_users_settings_and_decide_only_the_capacity():
    loads = basic_loads()
    daily, peak = battery.load_summary(loads)
    b = BatteryParams(usable_pct=100, roundtrip_pct=100, reserve_pct=100, cost_per_kwh=1000, power_kw=4.0)
    cards = battery.proposals(daily, peak, b, 1, 6.0)
    keys = [c["key"] for c in cards]
    assert keys == ["days_1", "days_2", "days_3", "per_kwp", "manual"]
    assert all(c["power_kw"] == 4.0 and not c["power_auto"] for c in cards)          # a typed power applies to all
    assert [c["capacity_kwh"] for c in cards[:3]] == [math.ceil(daily * d * 2) / 2 for d in (1, 2, 3)]
    assert all(c["capacity_ok"] for c in cards[:3])
    assert cards[3]["capacity_kwh"] == 6.0 and cards[3]["investment"] == 6000
    # the user's own target joins the day cards
    assert [c["key"] for c in battery.proposals(daily, peak, b, 1.5, None)] == ["days_1", "days_1.5", "days_2", "days_3", "manual"]


def test_no_loads_gives_no_day_cards_and_no_division_by_zero():
    res = battery.autonomy(AutonomyRequest(loads=[], battery=BatteryParams(capacity_kwh=10)))
    assert res["daily_kwh"] == 0 and res["needed_capacity_kwh"] == 0
    assert [c["key"] for c in res["cards"]] == ["manual"]
    assert res["battery"]["days_full"] is None and not res["battery"]["capacity_ok"]


def test_api_presets_and_autonomy():
    p = client.get("/api/battery/presets").json()
    assert {a["key"] for a in p["appliances"]} >= {"fridge", "ac"} and p["sets"]["basic"] and p["batteries"][0]["capacity_kwh"] == 5
    body = {"loads": [{"kwh_day": 3.45, "peak_w": 790}], "target_days": 2,
            "battery": {"capacity_kwh": 10, "power_kw": 5}, "kwp": 8}
    r = client.post("/api/battery/autonomy", json=body)
    assert r.status_code == 200
    j = r.json()
    assert j["daily_kwh"] == 3.45 and abs(j["peak_kw"] - 0.55) < 0.01
    assert j["needed_capacity_kwh"] == math.ceil(3.45 * 2 / (math.sqrt(0.9) * 0.9) * 2) / 2
    assert j["battery"]["capacity_kwh"] == 10 and j["battery"]["days_guaranteed"] > 2
    assert client.post("/api/battery/autonomy", json={"battery": {"usable_pct": 0}}).status_code == 422


def test_catalog_entries_are_valid_and_reach_the_api():
    for b in battery.CATALOG_BATTERIES:  # the catalog file may be empty; whatever is in it must be sane
        assert b.usable_kwh <= b.capacity_kwh and 0.05 <= b.power_kw / b.capacity_kwh <= 2.5
    assert client.get("/api/battery/presets").json()["catalog"] == [b.model_dump() for b in battery.CATALOG_BATTERIES]
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        battery.CatalogBattery(name="x" * 5, brand="Test", chemistry="LFP", capacity_kwh=5, usable_kwh=6,
                               power_kw=2.5, coupling="ac", source="https://example.com/datasheet.pdf")
