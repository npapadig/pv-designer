"""Hourly battery model: how much of the solar energy is used on site, and how much is bought and sold, with and without a battery.

Data (a typical year, 8760 hours):
- Production: the AC energy of the inverter in every hour (kWh), from the detailed simulation (backend/simulation.py).
- Consumption: the yearly kWh (given by the user, else assumed equal to the production), spread over the year with a monthly factor
  ("season") and an hourly shape of the day ("profile"). The shape is in LOCAL time: UTC + round(longitude / 15) hours, plus one hour
  from April to October in Europe (summer time). The yearly total is kept exactly.

Every hour, in kWh (1 hour, so kWh = kW):
    direct   = min(production, consumption)             used at once
    surplus  = production - direct  ->  charges the battery (limited by power, and by the room left), the rest is exported
    deficit  = consumption - direct ->  comes from the battery (limited by power, and by the energy above the reserve), the rest is bought
The battery keeps its usable energy between 0 and `usable`; `reserve_pct` of it is never used for saving (it stays for outages).
Round-trip efficiency is split evenly: eta = sqrt(round trip) when charging and again when discharging.
Self-consumption % = (production - export) / production; autarky (self-sufficiency) % = 1 - bought / consumption.

Over the years (finance): production falls by the panel degradation, the battery loses `fade_pct_per_year` of its capacity for every year
of age and is replaced in `replacement_year` (a new battery, at `replacement_cost_pct` of the original price).
Not modelled: tariffs that change by hour, charging from the grid, intra-hour peaks, temperature.
"""
from __future__ import annotations

import math
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from .battery import BatteryParams, auto_power_kw, cost

# Share of the day's energy in each LOCAL hour 0..23 (relative weights, normalised when used). Typical shapes, not measurements.
LOAD_SHAPES: dict[str, list[float]] = {
    "home": [0.55, 0.50, 0.48, 0.47, 0.48, 0.55, 0.75, 0.95, 0.90, 0.80, 0.75, 0.78,
             0.85, 0.90, 0.85, 0.80, 0.85, 1.00, 1.25, 1.45, 1.55, 1.50, 1.20, 0.80],
    "home_day": [0.50, 0.48, 0.46, 0.46, 0.47, 0.52, 0.65, 0.80, 0.90, 1.00, 1.10, 1.15,
                 1.20, 1.20, 1.15, 1.10, 1.10, 1.15, 1.25, 1.35, 1.35, 1.20, 0.90, 0.65],
    "office": [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.50, 1.00, 1.60, 1.70, 1.70, 1.70,
               1.50, 1.60, 1.70, 1.70, 1.60, 1.30, 0.90, 0.60, 0.40, 0.30, 0.25, 0.25],
    "always_on": [0.90, 0.88, 0.87, 0.87, 0.88, 0.92, 0.98, 1.05, 1.10, 1.12, 1.12, 1.12,
                  1.10, 1.10, 1.10, 1.10, 1.10, 1.08, 1.05, 1.02, 1.00, 0.97, 0.94, 0.92],
    "farm": [0.10, 0.10, 0.10, 0.10, 0.10, 0.30, 1.00, 2.00, 2.30, 2.40, 2.40, 2.40,
             2.40, 2.40, 2.40, 2.30, 2.00, 1.00, 0.40, 0.15, 0.10, 0.10, 0.10, 0.10],
    "flat": [1.0] * 24,
}
# Factor of each month (January..December), relative; the yearly total is kept.
SEASONS: dict[str, list[float]] = {
    "mixed": [1.15, 1.10, 0.95, 0.85, 0.85, 1.00, 1.20, 1.20, 0.95, 0.85, 0.95, 1.10],     # heating in winter, cooling in summer
    "summer": [0.95, 0.90, 0.85, 0.80, 0.85, 1.05, 1.30, 1.30, 1.05, 0.85, 0.90, 1.00],    # air conditioners
    "winter": [1.35, 1.25, 1.05, 0.85, 0.75, 0.80, 0.90, 0.90, 0.80, 0.85, 1.10, 1.30],    # electric heating
    "flat": [1.0] * 12,
}
MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
MIN_CAPACITY_FACTOR = 0.3   # the battery never counts as less than 30 % of its size in the finance years


class LoadParams(BaseModel):
    annual_kwh: float | None = Field(None, ge=0, le=100_000_000, description="None = assume the production")
    profile: Literal["home", "home_day", "office", "always_on", "farm", "flat"] = "home"
    season: Literal["mixed", "summer", "winter", "flat"] = "mixed"


def local_offset_hours(lat: float, lon: float, months: np.ndarray) -> np.ndarray:
    """Hours to add to UTC to get the local clock hour of each time step (summer time in Europe, April-October)."""
    base = int(round(lon / 15.0))
    europe = 34 <= lat <= 72 and -10 <= lon <= 45
    dst = ((months >= 4) & (months <= 10)).astype(int) if europe else 0
    return base + dst


def _local_hours(index: pd.DatetimeIndex, lat: float, lon: float) -> np.ndarray:
    return (index.hour.to_numpy() + local_offset_hours(lat, lon, index.month.to_numpy())) % 24


def hourly_load(index: pd.DatetimeIndex, annual_kwh: float, profile: str, season: str, lat: float, lon: float) -> np.ndarray:
    """kWh in every hour of `index` (UTC). The sum is exactly annual_kwh."""
    shape = np.asarray(LOAD_SHAPES[profile], float)
    shape = shape / shape.sum()
    month_f = np.asarray(SEASONS[season], float)
    w = month_f[index.month.to_numpy() - 1] * shape[_local_hours(index, lat, lon)]
    total = w.sum()
    return w * (annual_kwh / total) if total > 0 else np.zeros(len(index))


def metrics(production: float, consumption: float, import_kwh: float, export_kwh: float) -> dict:
    self_kwh = production - export_kwh
    return {
        "self_kwh": round(self_kwh, 1), "export_kwh": round(export_kwh, 1), "import_kwh": round(import_kwh, 1),
        "self_consumption_pct": round(100.0 * self_kwh / production, 1) if production > 0 else 0.0,
        "autarky_pct": round(100.0 * (consumption - import_kwh) / consumption, 1) if consumption > 0 else 0.0,
    }


def without_battery(pv: np.ndarray, load: np.ndarray) -> dict:
    direct = np.minimum(pv, load)
    return {"production": float(pv.sum()), "consumption": float(load.sum()),
            "import": float((load - direct).sum()), "export": float((pv - direct).sum())}


def dispatch(pv, load, capacity_kwh: float, usable_pct: float, roundtrip_pct: float, power_kw: float,
             reserve_pct: float, series: bool = False) -> dict:
    """The hour-by-hour operation (see the module text). pv, load: kWh per hour. Starts at the reserve level.
    With series=True the answer also has "charge", "discharge" (kWh per hour) and "stored" (usable kWh after the hour) as arrays."""
    pv_l = np.asarray(pv, float).tolist()
    load_l = np.asarray(load, float).tolist()
    n = len(pv_l)
    cap = capacity_kwh * usable_pct / 100.0
    eta = math.sqrt(roundtrip_pct / 100.0)
    floor = cap * reserve_pct / 100.0
    e = floor
    charged = discharged = drawn = imp = exp = 0.0
    ch_s = [0.0] * n if series else None
    dis_s = [0.0] * n if series else None
    soc_s = [0.0] * n if series else None
    if cap <= 0:
        base = without_battery(np.asarray(pv, float), np.asarray(load, float))
        out = {"production": base["production"], "consumption": base["consumption"], "import": base["import"],
               "export": base["export"], "charged": 0.0, "discharged": 0.0, "cycles": 0.0, "capacity_used": 0.0}
        if series:
            z = np.zeros(n)
            out.update(charge=z, discharge=z.copy(), stored=z.copy())
        return out
    for i in range(n):
        p = pv_l[i]
        l = load_l[i]
        if p >= l:
            s = p - l
            if s > 0.0 and e < cap:
                x = (cap - e) / eta
                if x > power_kw:
                    x = power_kw
                if x > s:
                    x = s
                e += x * eta
                charged += x
                s -= x
                if series:
                    ch_s[i] = x
            exp += s
        else:
            r = l - p
            if e > floor:
                y = (e - floor) * eta
                if y > power_kw:
                    y = power_kw
                if y > r:
                    y = r
                e -= y / eta
                discharged += y
                drawn += y / eta
                r -= y
                if series:
                    dis_s[i] = y
            imp += r
        if series:
            soc_s[i] = e
    out = {"production": float(sum(pv_l)), "consumption": float(sum(load_l)), "import": imp, "export": exp,
           "charged": charged, "discharged": discharged, "cycles": drawn / cap, "capacity_used": cap}
    if series:
        out.update(charge=np.asarray(ch_s), discharge=np.asarray(dis_s), stored=np.asarray(soc_s))
    return out


def _power(b: BatteryParams, capacity_kwh: float) -> float:
    return b.power_kw if b.power_kw is not None else auto_power_kw(capacity_kwh, 0.0)


def _run(pv, load, b: BatteryParams, capacity_kwh: float, series: bool = False) -> dict:
    return dispatch(pv, load, capacity_kwh, b.usable_pct, b.roundtrip_pct, _power(b, capacity_kwh), b.reserve_pct, series)


def _monthly(index: pd.DatetimeIndex, arrays: dict[str, np.ndarray]) -> list[dict]:
    m = index.month.to_numpy() - 1
    sums = {k: np.bincount(m, weights=v, minlength=12) for k, v in arrays.items()}
    return [{"month": i + 1, **{k: round(float(v[i]), 1) for k, v in sums.items()}} for i in range(12)]


def _day_profiles(index: pd.DatetimeIndex, lat: float, lon: float, arrays: dict[str, np.ndarray]) -> dict:
    """Average day of every month by local hour: {month: {name: [24 values]}}."""
    key = (index.month.to_numpy() - 1) * 24 + _local_hours(index, lat, lon)
    count = np.maximum(np.bincount(key, minlength=288), 1)
    out = {str(i + 1): {} for i in range(12)}
    for name, v in arrays.items():
        avg = (np.bincount(key, weights=v, minlength=288) / count).reshape(12, 24)
        for i in range(12):
            out[str(i + 1)][name] = [round(float(x), 3) for x in avg[i]]
    return out


def load_for(pv: pd.Series, lat: float, lon: float, load: LoadParams) -> tuple[np.ndarray, float, bool]:
    """(hourly consumption, yearly kWh, assumed?) for the production series."""
    assumed = load.annual_kwh is None or load.annual_kwh <= 0
    annual = float(pv.sum()) if assumed else float(load.annual_kwh)
    return hourly_load(pv.index, annual, load.profile, load.season, lat, lon), annual, assumed


def simulate_year(pv: pd.Series, lat: float, lon: float, load: LoadParams, b: BatteryParams) -> dict:
    """Year 1 with and without the battery, per month, and the average day of every month (for the chart)."""
    pv_a = pv.to_numpy(float)
    load_a, annual, assumed = load_for(pv, lat, lon, load)
    base = without_battery(pv_a, load_a)
    run = _run(pv_a, load_a, b, b.capacity_kwh, series=True)
    power = _power(b, b.capacity_kwh)
    without = metrics(base["production"], base["consumption"], base["import"], base["export"])
    with_ = {**metrics(run["production"], run["consumption"], run["import"], run["export"]),
             "charged_kwh": round(run["charged"], 1), "discharged_kwh": round(run["discharged"], 1),
             "cycles": round(run["cycles"], 1)}
    direct_with = np.minimum(pv_a, load_a)
    imp_with = load_a - direct_with - run["discharge"]
    exp_with = pv_a - direct_with - run["charge"]
    monthly = _monthly(pv.index, {"production_kwh": pv_a, "load_kwh": load_a,
                                  "import_without_kwh": load_a - direct_with, "import_with_kwh": imp_with,
                                  "export_without_kwh": pv_a - direct_with, "export_with_kwh": exp_with})
    cap = run["capacity_used"]
    soc_pct = run["stored"] / cap * 100.0 if cap > 0 else np.zeros(len(pv_a))
    days = _day_profiles(pv.index, lat, lon, {"pv": pv_a, "load": load_a, "charge": run["charge"], "discharge": run["discharge"],
                                              "soc_pct": soc_pct, "import": imp_with, "export": exp_with})
    return {
        "production_kwh": round(base["production"], 1), "load_kwh": round(annual, 1), "assumed_consumption": assumed,
        "capacity_kwh": b.capacity_kwh, "power_kw": round(power, 2), "usable_kwh": round(cap, 2), "reserve_pct": b.reserve_pct,
        "without": without, "with": with_, "monthly": monthly, "day_profiles": days,
    }


def storage_for_finance(pv: pd.Series, lat: float, lon: float, load: LoadParams, b: BatteryParams,
                        years: int, degradation_pct: float) -> dict:
    """Per year of the lifetime: what the system produces, uses on site, exports and buys, with and without the battery
    (input of finance.analyse). The panels degrade; the battery fades and is replaced in b.replacement_year."""
    pv_a = pv.to_numpy(float)
    load_a, annual, _ = load_for(pv, lat, lon, load)
    with_years, without_years = [], []
    for y in range(1, years + 1):
        f = (1.0 - degradation_pct / 100.0) ** (y - 1)
        pv_y = pv_a * f
        age = y if not b.replacement_year or y < b.replacement_year else y - b.replacement_year + 1
        cap_y = b.capacity_kwh * max(1.0 - b.fade_pct_per_year / 100.0 * (age - 1), MIN_CAPACITY_FACTOR)
        base = without_battery(pv_y, load_a)
        run = _run(pv_y, load_a, b, cap_y) if b.capacity_kwh > 0 else None
        for out, r in ((without_years, base), (with_years, run or base)):
            out.append({"production": r["production"], "self": r["production"] - r["export"],
                        "export": r["export"], "import": r["import"]})
    c = cost(b.capacity_kwh, b)
    first = {"with": metrics(with_years[0]["production"], annual, with_years[0]["import"], with_years[0]["export"]),
             "without": metrics(without_years[0]["production"], annual, without_years[0]["import"], without_years[0]["export"])}
    return {
        "annual_kwh": annual, "years": with_years, "years_without": without_years, "summary": first,
        "capex": c["capex"], "investment": c["investment"],
        "replacement_year": b.replacement_year if b.capacity_kwh > 0 else 0,
        "replacement_cost": b.capacity_kwh * b.cost_per_kwh * b.replacement_cost_pct / 100.0,
    }
