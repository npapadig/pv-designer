"""The battery on the user's own data (backend/battery_real.py): same rules as the hourly model, now at any step, plus the verdict."""
import time

import numpy as np
import pandas as pd

from backend import battery_plan, battery_real as br, battery_sim
from backend.battery import BatteryParams

LAT, LON = 37.98, 23.72
IDX = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
_h = IDX.hour.to_numpy()
_doy = IDX.dayofyear.to_numpy()
PV = pd.Series(np.clip(np.sin((_h - 6) / 12 * np.pi), 0, None) * (0.5 + 0.5 * np.sin((_doy - 80) / 365 * 2 * np.pi)) * 4.0, index=IDX)
DATA = {"kwp": 6.0, "scheme": "net_billing", "retail_price": 0.20, "export_price": 0.07, "lifetime_years": 15, "degradation_pct": 0.5,
        "capex_per_kwp": 1100.0}


def _inputs(load, pv=PV, step=60):
    return {"load": pd.Series(load, index=pv.index), "pv": pv, "step_minutes": step, "notes": [], "pv_source": "measured",
            "load_source": "consumption"}


def _home_load(total=6000):
    return battery_sim.hourly_load(IDX, total, "home", "mixed", LAT, LON)


def test_many_cases_at_once_equal_the_single_hourly_model():
    load = _home_load()
    caps, scales, power = [0.0, 5.0, 10.0, 10.0, 20.0], [1.0, 1.0, 1.0, 0.9, 1.0], [0.0, 2.5, 5.0, 5.0, 3.0]
    res = br.dispatch_many(PV.to_numpy(), load, caps, scales, power, 90, 90, 20)
    for k in range(len(caps)):
        one = battery_sim.dispatch(PV.to_numpy() * scales[k], load, caps[k], 90, 90, power[k], 20)
        for name in ("import", "export", "charged", "discharged", "cycles"):
            assert abs(res[name][k] - one[name]) < 1e-6 * max(1.0, abs(one[name])), (k, name)


def test_a_finer_step_with_flat_data_gives_the_same_flows():
    load = _home_load()

    def quarter(s):
        return pd.Series(np.repeat(s.to_numpy() / 4, 4), index=pd.date_range(s.index[0], periods=len(s) * 4, freq="15min"))
    pv4, load4 = quarter(PV), quarter(pd.Series(load, index=IDX))
    b = BatteryParams(capacity_kwh=10, reserve_pct=0)
    h = br.storages_for_sizes(PV.to_numpy(), load, 60, b, [10.0], 3, 0.5)[10.0]
    f = br.storages_for_sizes(pv4.to_numpy(), load4.to_numpy(), 15, b, [10.0], 3, 0.5)[10.0]
    for y in range(3):
        assert abs(h["years"][y]["import"] - f["years"][y]["import"]) < 0.5


def test_sizes_match_the_proposals_of_the_hourly_step_to_the_cent():
    """The same year through battery_plan (the existing step) and through the new engine: the finance numbers must agree."""
    load = _home_load()
    b = BatteryParams(capacity_kwh=0, reserve_pct=0)
    out = br.analyse(_inputs(load), b, DATA, sizes=[5.0, 10.0])
    assert [r["capacity_kwh"] for r in out["sweep"]] == [5.0, 10.0]
    for row in out["sweep"]:
        ref = battery_plan._row(PV, LAT, LON, battery_sim.LoadParams(annual_kwh=6000, profile="home", season="mixed"), b,
                                row["capacity_kwh"], {**DATA, "annual_kwh": 1.0})
        assert abs(ref["npv_gain"] - row["npv_gain"]) < 0.01 and ref["payback_years"] == row["payback_years"]
        assert abs(ref["autarky_pct"] - row["autarky_pct"]) < 0.05


def test_meter_file_plus_inverter_file_rebuild_the_real_consumption():
    true_load = _home_load(5000)
    prod = PV.to_numpy() * 0.8
    direct = np.minimum(prod, true_load)
    imp_a, exp_a = true_load - direct, prod - direct
    meter = {"series": {"import": pd.Series(imp_a, index=IDX), "export": pd.Series(exp_a, index=IDX)}, "kind": "meter", "step_minutes": 60}
    inverter = {"series": {"import": pd.Series(prod, index=IDX)}, "kind": "production", "step_minutes": 60}
    r = br.build_inputs(meter, inverter, None, LAT, LON, has_pv=True)
    assert np.allclose(r["load"].to_numpy(), true_load, atol=1e-9) and r["pv_source"] == "measured"
    r2 = br.build_inputs(meter, None, PV.tz_localize("UTC"), LAT, LON, has_pv=False)    # no PV yet: the meter IS the building
    assert np.allclose(r2["load"].to_numpy(), imp_a) and r2["pv_source"] == "forecast"


def test_meter_with_existing_pv_but_no_production_file_says_the_production_is_estimated():
    ser = {"import": pd.Series(np.full(len(IDX), 0.5), index=IDX), "export": pd.Series(np.zeros(len(IDX)), index=IDX)}
    c = {"series": ser, "kind": "meter", "step_minutes": 60}
    r = br.build_inputs(c, None, PV.tz_localize("UTC"), LAT, LON, has_pv=True, calibrate_kwh=4000)
    assert "production_estimated" in r["notes"] and abs(r["pv"].sum() - 4000) < 1.0
    assert "export_unknown" not in r["notes"]                          # the meter file has an export column


def test_meter_with_existing_pv_and_no_export_data_warns_that_the_surplus_is_unknown():
    c = {"series": {"import": pd.Series(np.full(len(IDX), 0.5), index=IDX)}, "kind": "meter", "step_minutes": 60}
    r = br.build_inputs(c, None, PV.tz_localize("UTC"), LAT, LON, has_pv=True, calibrate_kwh=4000)
    assert "export_unknown" in r["notes"]
    inj = {"series": {"import": pd.Series(np.zeros(len(IDX)), index=IDX)}, "kind": "consumption", "step_minutes": 60, "filename": "inj.csv"}
    assert "export_unknown" not in br.build_inputs(c, None, PV.tz_localize("UTC"), LAT, LON, has_pv=True, calibrate_kwh=4000, injection=inj)["notes"]
    assert "export_unknown" not in br.build_inputs(c, None, PV.tz_localize("UTC"), LAT, LON, has_pv=False)["notes"]    # no PV: the meter is the building


def test_forecast_is_laid_on_the_local_clock_and_the_dates_of_the_file():
    utc = pd.Series(0.0, index=pd.date_range("2005-01-01", "2005-12-31 23:00", freq="h", tz="UTC"))
    utc[(utc.index.month == 7) & (utc.index.day == 10) & (utc.index.hour == 9)] = 3.0     # 09:00 UTC = 12:00 local (summer time, UTC+3)
    local = br.on_calendar(br.forecast_local(utc, LAT, LON), pd.date_range("2024-01-01", "2024-12-31 23:45", freq="15min"), 15)
    peak = local[local > 0]
    assert list(peak.index) == [pd.Timestamp(f"2024-07-10 12:{m:02d}") for m in (0, 15, 30, 45)] and abs(peak.sum() - 3.0) < 1e-9
    assert len(local) == 366 * 96                                                       # a leap year: 29 February is filled


def test_verdict_yes_when_cheap_no_when_expensive_and_reasons_are_given():
    load = _home_load(6500)
    cheap = br.analyse(_inputs(load), BatteryParams(reserve_pct=0, cost_per_kwh=150.0), DATA)
    dear = br.analyse(_inputs(load), BatteryParams(reserve_pct=0, cost_per_kwh=5000.0), DATA)
    assert cheap["verdict"]["code"] in ("yes", "marginal") and cheap["best"]["npv_gain"] > 0
    assert dear["verdict"]["code"] == "no" and dear["best"]["npv_gain"] <= 0
    nm = br.analyse(_inputs(load), BatteryParams(reserve_pct=0), {**DATA, "scheme": "net_metering"})
    assert "net_metering" in nm["verdict"]["reasons"]


def test_full_answer_has_the_balance_months_days_and_daily_totals():
    out = br.analyse(_inputs(_home_load()), BatteryParams(reserve_pct=0), DATA)
    d, base = out["detail"], out["base"]
    assert abs(base["direct_kwh"] + base["import_kwh"] - base["consumption_kwh"]) < 1.0
    assert abs(base["direct_kwh"] + base["export_kwh"] - base["production_kwh"]) < 1.0
    w = d["with"]
    assert w["import_kwh"] < base["import_kwh"] and w["export_kwh"] < base["export_kwh"]
    assert abs((base["import_kwh"] - w["import_kwh"]) - w["discharged_kwh"]) < 1.0
    assert len(d["months"]) == 12 and len(d["daily"]["date"]) == 365 and all(len(v) == 24 for v in d["day_profiles"]["summer"].values())
    summer = d["day_profiles"]["summer"]
    assert int(np.argmax(summer["discharge"])) > int(np.argmax(summer["charge"]))      # it takes around noon, gives later (evening)
    assert max(summer["charge"]) > 0 and max(summer["discharge"]) > 0
    assert out["sweep"][0]["capacity_kwh"] >= 2.5 and out["savings_possible"]


def test_reserve_100_percent_means_no_saving_and_no_sizes():
    out = br.analyse(_inputs(_home_load()), BatteryParams(reserve_pct=100), DATA)
    assert out["savings_possible"] is False and out["sweep"] == [] and out["verdict"]["code"] == "none"


def test_a_year_of_15_minute_data_runs_in_seconds():
    idx = pd.date_range("2025-01-01", "2025-12-31 23:45", freq="15min")
    h, doy = idx.hour.to_numpy() + idx.minute.to_numpy() / 60, idx.dayofyear.to_numpy()
    pv = pd.Series(np.clip(np.sin((h - 6) / 12 * np.pi), 0, None) * (0.6 + 0.4 * np.sin((doy - 80) / 365 * 2 * np.pi)) * 1.0, index=idx)
    load = pd.Series(0.18 + 0.1 * np.clip(np.sin((h - 15) / 12 * np.pi), 0, None), index=idx)
    t0 = time.time()
    out = br.analyse({"load": load, "pv": pv, "step_minutes": 15, "notes": [], "pv_source": "measured", "load_source": "consumption"},
                     BatteryParams(reserve_pct=0), {**DATA, "kwp": 5.0})
    print("15-minute year took", round(time.time() - t0, 1), "s")
    assert time.time() - t0 < 40 and out["detail"]["with"]["autarky_pct"] > out["base"]["autarky_pct"]


def _parsed(values, idx, kind="consumption", name="f.csv"):
    step = int((idx[1] - idx[0]).total_seconds() // 60)
    return {"series": {"import": pd.Series(values, index=idx)}, "kind": kind, "step_minutes": step, "days": len(idx) * step / 1440,
            "full_year": len(idx) * step / 1440 >= 330, "covered_months": sorted(set(idx.month)), "notes": [], "missing_pct": 0.0, "filename": name}


def test_a_part_of_the_year_is_completed_from_the_nearest_months_and_the_coverage_is_told():
    idx = pd.date_range("2025-05-26", "2025-11-03 11:00", freq="h")                    # like the real file: 26 May - 3 Nov
    load = np.where(idx.month >= 9, 10.0, 30.0)                                       # summer 30 kWh per hour, from September 10
    r = br.build_inputs(_parsed(load, idx), None, PV.tz_localize("UTC"), LAT, LON, has_pv=False)
    cov = r["coverage"]
    assert "year_completed" in r["notes"] and len(r["load"]) == 8760 and abs(cov["real_pct"] - 44.2) < 1.0
    assert cov["estimated_months"] and 1 in cov["estimated_months"] and 7 in cov["real_months"]
    jan = r["load"][r["load"].index.month == 1]
    assert np.allclose(jan.to_numpy(), 10.0)                                          # January takes the nearest month with data: October (10)
    assert np.allclose(r["load"].loc[idx[0]:idx[-1]].to_numpy(), load)                # the measured part is untouched
    only = br.build_inputs(_parsed(load, idx), None, PV.tz_localize("UTC"), LAT, LON, has_pv=False, fill_year=False)
    assert "partial_period" in only["notes"] and len(only["load"]) == len(idx) and only["coverage"] is None


def test_analysis_of_a_completed_year_reports_the_coverage_per_month():
    idx = pd.date_range("2025-05-26", "2025-11-03 11:00", freq="h")
    inp = br.build_inputs(_parsed(np.full(len(idx), 2.0), idx), None, PV.tz_localize("UTC"), LAT, LON, has_pv=False)
    out = br.analyse(inp, BatteryParams(reserve_pct=0), DATA, sizes=[5.0])
    assert out["coverage"]["real_pct"] < 50 and out["days"] == 365.0 and out["annual_factor"] == 1.0


def test_files_of_the_same_kind_are_joined_into_one_year():
    a = pd.date_range("2025-01-01", "2025-06-30 23:00", freq="h")
    b = pd.date_range("2025-07-01", "2025-12-31 23:00", freq="h")
    m = br.merge_parsed([_parsed(np.ones(len(a)), a, name="a.csv"), _parsed(np.ones(len(b)) * 2, b, name="b.csv")])
    assert m["full_year"] and m["days"] == 365.0 and "merged_files" in m["notes"] and m["filename"] == "a.csv + b.csv"
    assert abs(m["series"]["import"].sum() - (len(a) + 2 * len(b))) < 1e-6
    try:
        br.merge_parsed([_parsed(np.ones(len(a)), a), _parsed(np.ones(len(b)), b, kind="production")])
        assert False
    except ValueError as e:
        assert "ίδιου είδους" in str(e)


def test_injection_file_is_taken_off_the_meter_consumption():
    cons = _parsed(np.full(len(IDX), 1.0), IDX, kind="meter")
    inj = _parsed(np.full(len(IDX), 0.25), IDX, kind="consumption", name="inj.csv")
    prod = _parsed(np.full(len(IDX), 0.5), IDX, kind="production")
    r = br.build_inputs(cons, prod, None, LAT, LON, has_pv=True, injection=inj)
    assert np.allclose(r["load"].to_numpy(), 1.0 - 0.25 + 0.5)
