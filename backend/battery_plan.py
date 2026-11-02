"""Battery sizing from the hourly model, and how long the backup lasts when the grid is down but the sun shines.

Sizes (`propose`): a sweep of capacities, each one through the same yearly flows and the same financial analysis the finance step uses
for a battery (battery_sim.storage_for_finance, finance.analyse), so a card shows what the finance step will show once that size is
chosen. Every setting the user gave (power, efficiency, reserve, costs, consumption, consumer type) applies to every size; only the
capacity changes. The cards (sizes from battery.MIN_CARD_KWH up):
- "eco": the size with the largest gain (NPV) over the lifetime; when no size gains anything, "eco_no" with the least bad one;
- "night": the smallest size that holds the average consumption of the hours without sun;
- "autarky": the smallest size that brings 90 % of the largest rise of self-sufficiency found.
With the reserve at 100 % the battery only waits for an outage and never saves anything: there is nothing to propose.

Outage (`outage_by_month`): the grid is down, only the loads to keep run (their daily energy, spread over the day like the consumer type),
and the sun still charges the battery (an inverter that works without the grid is assumed). Every hour of the year is tried as the
start, with the battery at the level the reserve guarantees; the outage lasts until the battery cannot cover the loads, at most
OUTAGE_MAX_DAYS. Reported per month: the shortest and the average.
Not modelled: peaks inside an hour, start-up currents, the power limit of the battery (that check is in the autonomy step), a worse
run of cloudy days than the typical year has.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import battery, battery_sim, finance
from .battery import BatteryParams
from .battery_sim import LoadParams

SWEEP_POINTS = 30                 # at most this many sizes besides 0
SWEEP_STEPS = (0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000)   # kWh between two sizes
SWEEP_DAYS = 1.5                  # the largest size tried holds this many days of the consumption ...
SWEEP_MIN_TOP_KWH = 10.0          # ... or at least this much
SWEEP_MAX_KWH = 5000.0            # the largest battery the parameters allow
AUTARKY_SHARE = 0.9               # the "autarky" card: this share of the largest rise of self-sufficiency
NIGHT_PV_SHARE = 0.01             # an hour is dark when the production is below this share of the best hour of the year
OUTAGE_MAX_DAYS = 30              # longer is reported as "30 or more" (practically open ended)


def sweep_capacities(daily_kwh: float) -> list[float]:
    """The sizes to try (kWh): 0, then equal steps up to about SWEEP_DAYS days of the consumption (at least 10 kWh)."""
    top = min(max(SWEEP_MIN_TOP_KWH, SWEEP_DAYS * daily_kwh), SWEEP_MAX_KWH)
    step = next((s for s in SWEEP_STEPS if top / s <= SWEEP_POINTS), SWEEP_STEPS[-1])
    count = math.ceil(round(top / step, 6))
    return [round(i * step, 2) for i in range(count + 1)]


def night_kwh_per_day(pv: np.ndarray, load: np.ndarray) -> float:
    """The average consumption per day (kWh) in the hours without (almost) any sun."""
    dark = pv <= NIGHT_PV_SHARE * float(pv.max())
    return float(load[dark].sum() / (len(pv) / 24.0))


def night_capacity_kwh(night_kwh: float, b: BatteryParams) -> float:
    """Nominal capacity that holds `night_kwh` of the usable energy that is free for saving (the part above the reserve)."""
    free = (100.0 - b.reserve_pct) / 100.0
    return night_kwh / (battery.discharge_eff(b) * (b.usable_pct / 100.0) * free)


def _row(pv: pd.Series, lat: float, lon: float, load: LoadParams, b: BatteryParams, capacity_kwh: float, data: dict) -> dict:
    """One size, with the numbers of the finance step for it (the battery part of finance.analyse)."""
    sized = b.model_copy(update={"capacity_kwh": capacity_kwh})
    st = battery_sim.storage_for_finance(pv, lat, lon, load, sized, data["lifetime_years"], data["degradation_pct"])
    res = finance.analyse(finance.FinanceParams(**{**data, "annual_kwh": st["years"][0]["production"], "storage": st}))
    g = res["battery"]
    return {
        "capacity_kwh": capacity_kwh, "power_kw": round(battery_sim._power(sized, capacity_kwh), 2),
        "capex": g["capex"], "investment": g["investment"], "first_year_gain": g["first_year_gain"],
        "payback_years": g["payback_years"], "npv_gain": g["npv_gain"],
        "self_consumption_pct": g["self_consumption_with_pct"], "autarky_pct": g["autarky_with_pct"],
    }


def propose(pv: pd.Series, lat: float, lon: float, load: LoadParams, b: BatteryParams, data: dict,
            daily_kwh: float, peak_kw: float, target_days: float) -> dict:
    """The sweep of sizes and the cards. `data`: the arguments of finance.FinanceParams except the battery (kwp and the settings);
    daily_kwh, peak_kw: the loads to keep, for the days of autonomy of every card."""
    load_a, annual, assumed = battery_sim.load_for(pv, lat, lon, load)
    out = {"savings": b.reserve_pct < 100.0, "reserve_pct": b.reserve_pct, "production_kwh": round(float(pv.sum()), 1),
           "consumption_kwh": round(annual, 1), "assumed_consumption": assumed, "cards": [], "sweep": []}
    if not out["savings"]:
        return out
    rows = [_row(pv, lat, lon, load, b, c, data) for c in sweep_capacities(annual / 365.0)]
    base = rows[0]
    sizes = [r for r in rows[1:] if r["capacity_kwh"] >= battery.MIN_CARD_KWH - 1e-9] or rows[1:]   # no card for a size nobody sells
    out["sweep"], out["base"] = rows, {"self_consumption_pct": base["self_consumption_pct"], "autarky_pct": base["autarky_pct"]}

    def card(kind: str, row: dict, **extra) -> dict:
        ev = battery.evaluate(daily_kwh, peak_kw, row["capacity_kwh"], row["power_kw"], b, target_days)
        return {"key": kind, "kind": kind, **row, **{k: ev[k] for k in ("usable_kwh", "days_full", "days_guaranteed", "capacity_ok", "power_ok")}, **extra}

    best = sizes[0]
    for r in sizes[1:]:
        if r["npv_gain"] > best["npv_gain"] + 1e-9:
            best = r
    out["cards"].append(card("eco" if best["npv_gain"] > 0 else "eco_no", best))

    night = night_kwh_per_day(pv.to_numpy(float), load_a)
    out["night_kwh_day"] = round(night, 2)
    if night > 0:
        need = night_capacity_kwh(night, b)
        row = next((r for r in sizes if r["capacity_kwh"] >= need - 1e-9), sizes[-1])
        out["cards"].append(card("night", row, night_kwh=round(night, 2), needed_kwh=round(need, 2), above_sweep=need > sizes[-1]["capacity_kwh"] + 1e-9))

    gains = [r["autarky_pct"] - base["autarky_pct"] for r in sizes]
    if max(gains) > 0.05:
        row = next(r for r, g in zip(sizes, gains) if g >= AUTARKY_SHARE * max(gains) - 1e-9)
        out["cards"].append(card("autarky", row, autarky_gain_pct=round(row["autarky_pct"] - base["autarky_pct"], 1)))
    return out


def outage_by_month(pv: pd.Series, lat: float, lon: float, load: LoadParams, b: BatteryParams, daily_kwh: float,
                    max_days: int = OUTAGE_MAX_DAYS) -> dict:
    """How long the loads keep running when the grid goes down in each hour of the year, with the sun available. `daily_kwh`: the
    energy per day of the loads to keep."""
    pv_a = pv.to_numpy(float)
    n = len(pv_a)
    shape = np.asarray(battery_sim.LOAD_SHAPES[load.profile], float)
    need = daily_kwh * (shape / shape.sum())[battery_sim._local_hours(pv.index, lat, lon)]   # kWh of the loads in every hour
    usable = b.capacity_kwh * b.usable_pct / 100.0
    eta = math.sqrt(b.roundtrip_pct / 100.0)
    steps = max_days * 24
    wrap = np.arange(n + steps) % n                                  # the year goes on with its own beginning
    pv_x, need_x = pv_a[wrap], need[wrap]
    e = np.full(n, usable * b.reserve_pct / 100.0)                   # stored energy at the start of the outage: the guaranteed part
    alive = np.ones(n, bool)
    hours = np.zeros(n)
    for t in range(steps):
        gap = need_x[t:t + n] - pv_x[t:t + n]                        # > 0: the battery gives it, < 0: the sun's surplus charges it
        take = np.where(alive, np.maximum(gap, 0.0) / eta, 0.0)
        give = np.where(alive, np.maximum(-gap, 0.0) * eta, 0.0)
        short = take > e + 1e-12
        hours += np.where(alive, np.where(short, e / np.where(take > 0, take, 1.0), 1.0), 0.0)   # the last hour counts for the part it covers
        e = np.where(short, 0.0, np.minimum(usable, e - take + give))
        alive &= ~short
        if not alive.any():
            break
    days = hours / 24.0
    month = pv.index.month.to_numpy() - 1
    months = []
    for m in range(12):
        d = days[month == m]
        if d.size:
            months.append({"month": m + 1, "min_days": round(float(d.min()), 2), "mean_days": round(float(d.mean()), 2),
                           "full_pct": round(100.0 * float((d >= max_days - 1e-9).mean()), 1)})
    worst = min(months, key=lambda r: r["min_days"])
    return {"max_days": max_days, "daily_kwh": round(daily_kwh, 2), "capacity_kwh": b.capacity_kwh, "usable_kwh": round(usable, 2),
            "start_kwh": round(usable * b.reserve_pct / 100.0, 2), "months": months, "min_days": worst["min_days"],
            "worst_month": worst["month"]}
