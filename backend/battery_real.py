"""The battery on the user's own measurements: is it worth it, how big, and where (which months and hours) it earns.

Inputs (see battery_data.py): the consumption of the building and the production of the PV system, every 15 minutes or every hour for a
whole year, in kWh per step on a local clock time.
- The consumption is a file of the building ("consumption") or of the meter ("meter": taken from the grid, fed into the grid). With the
  meter the building's own use is  taken - fed + produced  (the production must then be known: the inverter's file, or the forecast).
- The production is the inverter's file (real), or the forecast of the app (a typical year, hourly) laid on the dates of the consumption by
  month, day and hour; the hours are split evenly inside the hour when the consumption is finer.
The year is simulated at the finest step of the data. Every step: the sun supplies the load first; the surplus charges the battery (up to its
power and room) and the rest is exported; the missing energy comes from the battery (up to its power and what is above the reserve) and the
rest is bought. Round-trip efficiency, reserve, fading and replacement are those of battery_sim; the money is the finance step's
(finance.analyse), so a size shows here what it will show in the finance step.
All sizes and all years of the lifetime are run together in one pass over the steps (vectors), so a year of 15-minute data takes seconds.
Not modelled: tariffs by hour of the day, charging from the grid, start-up currents, temperature (same as the rest of the battery step).
"""
from __future__ import annotations

import dataclasses
import math

import numpy as np
import pandas as pd

from . import battery, battery_data, battery_plan, battery_sim, finance
from .battery import BatteryParams

MAX_SIZES = 24
MIN_NET_BENEFIT_PCT = 5.0        # "yes" needs a gain of at least this % of the investment, over the lifetime
RARE_SURPLUS_PCT = 8.0           # less than this share of the production exported: little to store
HIGH_SELF_PCT = 85.0             # self-consumption already this high without the battery


# ---------------------------------------------------------------- putting the data on one time grid
def _step_of(s: pd.Series) -> int:
    return int(round((s.index[1] - s.index[0]).total_seconds() / 60.0))


def resample_energy(s: pd.Series, step: int) -> pd.Series:
    """kWh per record -> kWh per record of `step` minutes (coarser: sums; finer: the energy is split evenly)."""
    cur = _step_of(s)
    if cur == step:
        return s
    if step > cur:
        return s.resample(f"{step}min", closed="left", label="left").sum()
    ratio = cur // step
    idx = s.index.repeat(ratio) + pd.to_timedelta(np.tile(np.arange(ratio) * step, len(s)), unit="min")   # also for a series with jumps (clock changes)
    return pd.Series(np.repeat(s.to_numpy(float) / ratio, ratio), index=idx)


def forecast_local(pv_utc: pd.Series, lat: float, lon: float) -> pd.Series:
    """The hourly forecast (index UTC) with its index on the local clock (summer time in Europe), as the consumption's."""
    off = battery_sim.local_offset_hours(lat, lon, pv_utc.index.month.to_numpy())
    return pd.Series(pv_utc.to_numpy(float), index=pv_utc.index.tz_localize(None) + pd.to_timedelta(off, unit="h"))


def on_calendar(src: pd.Series, target: pd.DatetimeIndex, step: int) -> pd.Series:
    """The values of `src` (kWh per record) on the dates of `target`, by month, day and time of the day ("a typical year");
    29 February takes the 28th. The result is kWh per `step` minutes."""
    s = resample_energy(src, step)
    key = pd.MultiIndex.from_arrays([s.index.month, s.index.day, s.index.hour * 60 + s.index.minute])
    table = s.groupby(key).mean()
    tm, td = target.month.to_numpy(), target.day.to_numpy()
    td = np.where((tm == 2) & (td == 29), 28, td)
    tk = pd.MultiIndex.from_arrays([tm, td, target.hour * 60 + target.minute])
    out = table.reindex(tk)
    if out.isna().any():                                  # a date the source does not have: the same time of day on average
        daily = s.groupby(s.index.hour * 60 + s.index.minute).mean()
        fill = pd.Series(daily.reindex(target.hour * 60 + target.minute).to_numpy(float), index=out.index)
        out = out.fillna(fill)
    return pd.Series(out.to_numpy(float), index=target)


MIN_FILL_DAYS = 10               # a month with at least this many days of data can stand for itself and for the months next to it


def _daytype(idx: pd.DatetimeIndex) -> np.ndarray:
    return (idx.dayofweek.to_numpy() >= 5).astype(int)           # 0 working day, 1 Saturday / Sunday


def typical_fill(src: pd.Series, target: pd.DatetimeIndex, step: int) -> np.ndarray:
    """An ESTIMATE of kWh per step at the times of `target`, from the typical day of the months of `src` (by working day / weekend and
    time of the day). A month that has data stands for itself; a month without data takes the nearest one(s) in the calendar (the two at
    the same distance are averaged). Nothing about the season is added: the estimate is as good as the neighbours are similar."""
    ms = src.index.month.to_numpy()
    tod = src.index.hour.to_numpy() * 60 + src.index.minute.to_numpy()
    df = pd.DataFrame({"m": ms, "d": _daytype(src.index), "t": tod, "v": src.to_numpy(float)})
    by_day = df.groupby(["m", "d", "t"])["v"].mean()
    by_all = df.groupby(["m", "t"])["v"].mean()
    overall = df.groupby("t")["v"].mean()
    days = np.bincount(ms - 1, minlength=12) / (1440.0 / step)
    cand = [m for m in range(1, 13) if days[m - 1] >= MIN_FILL_DAYS] or [int(m) for m in np.unique(ms)]
    tm, td = target.month.to_numpy(), _daytype(target)
    tt = (target.hour * 60 + target.minute).to_numpy()
    out = np.zeros(len(target))
    for m in range(1, 13):
        sel = tm == m
        if not sel.any():
            continue
        if m in cand:
            picks = [m]
        else:
            dist = sorted((min(abs(m - c), 12 - abs(m - c)), c) for c in cand)
            picks = [c for d, c in dist if d == dist[0][0]]
        vals = []
        for c in picks:
            n = int(sel.sum())
            v = by_day.reindex(pd.MultiIndex.from_arrays([np.full(n, c), td[sel], tt[sel]])).to_numpy(float)
            alt = by_all.reindex(pd.MultiIndex.from_arrays([np.full(n, c), tt[sel]])).to_numpy(float)
            v = np.where(np.isnan(v), alt, v)
            vals.append(np.where(np.isnan(v), overall.reindex(tt[sel]).to_numpy(float), v))
        out[sel] = np.mean(vals, axis=0)
    return np.nan_to_num(out)


def complete_year(src: pd.Series, step: int) -> tuple[pd.Series, np.ndarray]:
    """A whole year (365 days from the first record of `src`): the measured records where there are, the estimate for the rest.
    Returns the series and the mask of the records that are real."""
    full = pd.date_range(src.index[0], periods=int(365 * 1440 / step), freq=f"{step}min")
    real = full.isin(src.index)
    vals = np.empty(len(full))
    vals[real] = src.reindex(full[real]).to_numpy(float)
    if (~real).any():
        vals[~real] = typical_fill(src, full[~real], step)
    return pd.Series(vals, index=full), real


def coverage_of(idx: pd.DatetimeIndex, real: np.ndarray, step: int) -> dict:
    """Which part of the year is measured and which months are an estimate."""
    per_day = 1440.0 / step
    month = idx.month.to_numpy() - 1
    tot = np.bincount(month, minlength=12)
    ok = np.bincount(month, weights=real.astype(float), minlength=12)
    share = np.where(tot > 0, ok / np.maximum(tot, 1), 0.0)
    return {"real_days": round(float(real.sum()) / per_day, 1), "estimated_days": round(float((~real).sum()) / per_day, 1),
            "real_pct": round(100.0 * float(real.mean()), 1),
            "real_months": [i + 1 for i in range(12) if share[i] >= 0.5],
            "estimated_months": [i + 1 for i in range(12) if share[i] < 0.5 and tot[i] > 0],
            "month_real_pct": [round(100.0 * float(x)) for x in share]}


def _forecast_pv(forecast_utc: pd.Series, lat: float, lon: float, index: pd.DatetimeIndex, step: int, calibrate_kwh: float | None) -> pd.Series:
    """The forecast on the dates of `index`; for an existing system, scaled so that a whole year is `calibrate_kwh`."""
    prod = on_calendar(forecast_local(forecast_utc, lat, lon), index, step)
    if calibrate_kwh and prod.sum() > 0:
        prod = prod * (calibrate_kwh / float(prod.sum()) * (len(prod) * step / 525600.0))
    return prod


def merge_parsed(files: list[dict]) -> dict:
    """Several files of the same kind (e.g. the months a DEDDIE download gives one by one) as one: the records are put together in time order
    (the finest step wins; a record in two files is taken once); a stretch missing between the files is filled like any gap."""
    if len(files) == 1:
        return files[0]
    kinds = {f["kind"] for f in files}
    if len(kinds) > 1:
        raise ValueError("Τα αρχεία που ένωσες δείχνουν διαφορετικά πράγματα (π.χ. κατανάλωση και παραγωγή). Ένωσε μόνο αρχεία του ίδιου είδους.")
    step = min(f["step_minutes"] for f in files)
    out = {**files[0], "series": {}}
    for role in {r for f in files for r in f["series"]}:
        parts = [resample_energy(f["series"][role], step) for f in files if role in f["series"]]
        s = pd.concat(parts).sort_index()
        s = s[~s.index.duplicated(keep="first")]
        grid = pd.date_range(s.index[0], s.index[-1], freq=f"{step}min")
        s, _ = battery_data._fill_gaps(s.reindex(grid), step)
        n_keep = int(365 * 1440 / step)
        out["series"][role] = s.iloc[-n_keep:] if len(s) > n_keep else s
    first = out["series"]["import"]
    days = len(first) * step / 1440.0
    out.update(step_minutes=step, days=round(days, 1), full_year=days >= battery_data.FULL_YEAR_DAYS,
               covered_months=battery_data._covered_months(first), filename=" + ".join(f["filename"] for f in files),
               start=first.index[0].isoformat(), end=(first.index[-1] + pd.Timedelta(minutes=step)).isoformat(),
               notes=sorted({n for f in files for n in f["notes"]} | {"merged_files"}),
               missing_pct=max(f["missing_pct"] for f in files))
    return out


def build_inputs(consumption: dict, production: dict | None, forecast_utc: pd.Series | None, lat: float, lon: float,
                 has_pv: bool = True, calibrate_kwh: float | None = None, injection: dict | None = None, fill_year: bool = True) -> dict:
    """The consumption of the building and the production on one grid.
    consumption / production: answers of battery_data.parse; production None = use the forecast (forecast_utc).
    has_pv: the building already has a PV system (then the meter's numbers are reduced by it). calibrate_kwh: for a forecast used as the
    production of an existing system, its real yearly kWh (the forecast's hours are scaled to it). injection: a separate file with the energy
    fed into the grid (DEDDIE gives it apart from the consumption). fill_year: a file that covers only part of the year is completed to a
    whole year with an estimate (`coverage` says what is real); with False the period is analysed alone and its result is scaled to a year.
    Returns {"load", "pv": Series of kWh per step, "step_minutes", "notes": [...], "pv_source", "load_source"}."""
    notes: list[str] = []
    cs = consumption["series"]
    kind = consumption["kind"]
    if kind == "production":
        raise ValueError("Το αρχείο της κατανάλωσης δείχνει παραγωγή. Διάλεξε «Κατανάλωση» ή «Μετρητής» για αυτό το αρχείο.")
    step = consumption["step_minutes"]
    prod_series = None
    if production is not None:
        step = min(step, production["step_minutes"])
        prod_series = production["series"]["import"]
    imp = resample_energy(cs["import"], step)
    exp = resample_energy(cs["export"], step) if "export" in cs else None
    if injection is not None:
        ex = resample_energy(injection["series"]["import"], step).reindex(imp.index)
        if ex.isna().mean() > 0.1:
            notes.append("injection_partly_missing")
        exp = ex.fillna(0.0)
        kind = "meter" if kind == "consumption" else kind
    pv_source = "measured" if production is not None else "forecast"
    if prod_series is not None:
        prod = resample_energy(prod_series, step)
        common = imp.index.intersection(prod.index)
        if len(common) * step / 1440.0 >= 0.9 * len(imp) * step / 1440.0:
            prod = prod.reindex(imp.index)
            prod = prod.fillna(0.0)
            if len(common) < len(imp):
                notes.append("production_partly_missing")
        else:                                              # other years: lay the production on the dates of the consumption
            prod = on_calendar(prod, imp.index, step)
            notes.append("different_years")
    else:
        if forecast_utc is None:
            raise ValueError("Δεν υπάρχει παραγωγή: ανέβασε το αρχείο του inverter ή υπολόγισε πρώτα την παραγωγή.")
        fl = forecast_local(forecast_utc, lat, lon)
        prod = on_calendar(fl, imp.index, step)
        if calibrate_kwh and prod.sum() > 0:
            prod = prod * (calibrate_kwh / float(prod.sum()) * (len(prod) * step / 525600.0))
            notes.append("forecast_calibrated")
    if kind == "meter":
        if has_pv:
            load = imp - (exp if exp is not None else 0.0) + prod
            if prod_series is None:
                notes.append("production_estimated")
            if exp is None:             # nothing says how much was sold: the consumption comes out too big and the surplus too small
                notes.append("export_unknown")
            neg = float((-load.clip(upper=0)).sum())
            if neg > 0:
                notes.append("negative_load_fixed")
            load = load.clip(lower=0)
        else:
            load = imp
    else:
        load = imp
    days = len(load) * step / 1440.0
    coverage = None
    if days < battery_data.FULL_YEAR_DAYS and fill_year:
        load, real = complete_year(load, step)
        if prod_series is not None:                       # measured production, also only for part of the year
            have = prod.reindex(load.index)
            gap = have.isna().to_numpy() | ~real
            if forecast_utc is not None:                  # the forecast, scaled to what the inverter really gave, fills the rest
                fl = _forecast_pv(forecast_utc, lat, lon, load.index, step, None).to_numpy()
                both = ~gap & (fl > 0)
                scale = float(have.to_numpy()[both].sum() / fl[both].sum()) if both.any() and fl[both].sum() > 0 else 1.0
                prod = pd.Series(np.where(gap, fl * scale, have.to_numpy()), index=load.index)
                notes.append("production_completed_by_forecast")
            else:
                known = prod.dropna()
                est = typical_fill(known, load.index, step)
                prod = pd.Series(np.where(gap, est, have.fillna(0.0).to_numpy()), index=load.index)
                notes.append("production_completed_by_typical_day")
        else:
            prod = _forecast_pv(forecast_utc, lat, lon, load.index, step, calibrate_kwh)
        coverage = coverage_of(load.index, real, step)
        notes.append("year_completed")
        days = len(load) * step / 1440.0
    elif days < battery_data.FULL_YEAR_DAYS:
        notes.append("partial_period")
    return {"load": load, "pv": prod, "step_minutes": step, "notes": notes, "pv_source": pv_source,
            "load_source": kind, "days": days, "coverage": coverage}


# ---------------------------------------------------------------- the hour-by-hour (or quarter-by-quarter) operation of many cases
def dispatch_many(pv: np.ndarray, load: np.ndarray, caps, scales, power_step, usable_pct: float, roundtrip_pct: float,
                  reserve_pct: float) -> dict:
    """Many batteries on the same year at once. pv, load: kWh per step. For every case k: nominal capacity caps[k] (kWh), a factor for the
    production (the panels' ageing) scales[k], and the most energy per step the battery can take or give power_step[k] (kW x hours).
    The rules are the ones of battery_sim.dispatch. Returns arrays (one value per case): import, export, charged, discharged, cycles."""
    caps = np.asarray(caps, float)
    scales = np.asarray(scales, float)
    power = np.asarray(power_step, float)
    cap = caps * usable_pct / 100.0
    eta = math.sqrt(roundtrip_pct / 100.0)
    floor = cap * reserve_pct / 100.0
    room_k = cap - floor
    e = floor.copy()
    k = len(caps)
    imp = np.zeros(k)
    exp = np.zeros(k)
    ch = np.zeros(k)
    dis = np.zeros(k)
    zero = np.zeros(k)
    pv_l = np.asarray(pv, float).tolist()
    load_l = np.asarray(load, float).tolist()
    minimum, maximum = np.minimum, np.maximum
    for i in range(len(pv_l)):
        d = pv_l[i] * scales - load_l[i]
        pos = maximum(d, zero)
        neg = maximum(-d, zero)
        x = minimum(minimum(pos, power), (cap - e) / eta)
        y = minimum(minimum(neg, power), maximum(e - floor, zero) * eta)
        e += x * eta - y / eta
        ch += x
        dis += y
        exp += pos - x
        imp += neg - y
    drawn = dis / eta
    return {"import": imp, "export": exp, "charged": ch, "discharged": dis,
            "cycles": np.where(cap > 0, drawn / np.where(cap > 0, cap, 1.0), 0.0)}


def _power_kw(b: BatteryParams, capacity: float) -> float:
    return b.power_kw if b.power_kw is not None else battery.auto_power_kw(capacity, 0.0)


def _fit_fade(b: BatteryParams, years: int) -> list[float]:
    """The share of its first capacity the battery still has in each year (fading; a new one after replacement_year)."""
    out = []
    for y in range(1, years + 1):
        age = y if not b.replacement_year or y < b.replacement_year else y - b.replacement_year + 1
        out.append(max(1.0 - b.fade_pct_per_year / 100.0 * (age - 1), battery_sim.MIN_CAPACITY_FACTOR))
    return out


def sizes_for(daily_kwh: float, fixed: list[float] | None = None) -> list[float]:
    """The capacities to try (not counting 0). `fixed`: the sizes to use instead (the user's own list)."""
    if fixed:
        return sorted({round(float(c), 2) for c in fixed if c and c > 0})[:MAX_SIZES]
    sweep = [c for c in battery_plan.sweep_capacities(daily_kwh) if c > 0]
    return sweep[:MAX_SIZES]


def storages_for_sizes(pv: np.ndarray, load: np.ndarray, step_minutes: int, b: BatteryParams, sizes: list[float], years: int,
                       degradation_pct: float, annual_factor: float = 1.0) -> dict[float, dict]:
    """For every size (and 0 = without): the per-year flows in the form of battery_sim.storage_for_finance, from one pass over the year."""
    dt = step_minutes / 60.0
    fade = _fit_fade(b, years)
    allsizes = [0.0] + list(sizes)
    caps, scales, powers = [], [], []
    for c in allsizes:
        for y in range(1, years + 1):
            cy = c * fade[y - 1]
            caps.append(cy)
            scales.append((1.0 - degradation_pct / 100.0) ** (y - 1))
            powers.append(_power_kw(b, cy) * dt if c > 0 else 0.0)
    res = dispatch_many(pv, load, caps, scales, powers, b.usable_pct, b.roundtrip_pct, b.reserve_pct)
    total_pv = float(np.sum(pv))
    annual = float(np.sum(load)) * annual_factor
    out: dict[float, dict] = {}
    for si, c in enumerate(allsizes):
        sl = slice(si * years, (si + 1) * years)
        yrs = []
        for y in range(years):
            prod = total_pv * scales[si * years + y] * annual_factor
            exp = float(res["export"][sl][y]) * annual_factor
            yrs.append({"production": prod, "self": prod - exp, "export": exp, "import": float(res["import"][sl][y]) * annual_factor})
        out[c] = {"years": yrs, "cycles": float(res["cycles"][sl][0]),
                  "charged": float(res["charged"][sl][0]) * annual_factor, "discharged": float(res["discharged"][sl][0]) * annual_factor,
                  "annual": annual}
    base = out[0.0]["years"]
    for c in sizes:
        st = out[c]
        cost = battery.cost(c, b)
        first = {"with": battery_sim.metrics(st["years"][0]["production"], annual, st["years"][0]["import"], st["years"][0]["export"]),
                 "without": battery_sim.metrics(base[0]["production"], annual, base[0]["import"], base[0]["export"])}
        st.update({"years_without": base, "summary": first, "annual_kwh": annual, "capex": cost["capex"], "investment": cost["investment"],
                   "replacement_year": b.replacement_year, "replacement_cost": c * b.cost_per_kwh * b.replacement_cost_pct / 100.0})
    return out


def _finance_row(c: float, st: dict, b: BatteryParams, data: dict, annual_load: float, step_minutes: int, power: float) -> dict:
    fields = {f.name for f in dataclasses.fields(finance.FinanceParams)}
    d = {k: v for k, v in data.items() if k in fields}
    d.update(annual_kwh=st["years"][0]["production"], annual_consumption_kwh=annual_load,
             storage={k: v for k, v in st.items() if k in ("years", "years_without", "summary", "annual_kwh", "capex", "investment",
                                                          "replacement_year", "replacement_cost")})
    res = finance.analyse(finance.FinanceParams(**d))
    g = res["battery"]
    return {
        "capacity_kwh": c, "power_kw": round(power, 2), "capex": g["capex"], "investment": g["investment"],
        "first_year_gain": g["first_year_gain"], "payback_years": g["payback_years"], "npv_gain": g["npv_gain"],
        "irr_pct": g["irr_pct"], "self_consumption_pct": g["self_consumption_with_pct"], "autarky_pct": g["autarky_with_pct"],
        "shifted_kwh": round(st["discharged"], 1), "cycles": round(st["cycles"], 1),
    }


# ---------------------------------------------------------------- the answer
def _verdict(best: dict | None, base: dict, b: BatteryParams, data: dict, years: int) -> dict:
    scheme = data.get("scheme", "net_billing")
    reasons = []
    if scheme == "net_metering":
        reasons.append("net_metering")
    if base["export_pct_of_production"] < RARE_SURPLUS_PCT:
        reasons.append("little_surplus")
    if base["self_consumption_pct"] >= HIGH_SELF_PCT:
        reasons.append("already_high_self_use")
    gap = float(data.get("retail_price", 0.2)) - float(data.get("export_price", 0.07))
    if scheme == "net_billing" and gap < 0.05:
        reasons.append("small_price_gap")
    if best is None:
        return {"code": "none", "reasons": reasons}
    life = b.replacement_year or 12
    pb = best["payback_years"]
    margin = best["npv_gain"] / best["investment"] * 100.0 if best["investment"] else 0.0
    if best["npv_gain"] <= 0 or pb is None:
        code = "no"
    elif pb <= life and margin >= MIN_NET_BENEFIT_PCT:
        code = "yes"
    else:
        code = "marginal"
    return {"code": code, "capacity_kwh": best["capacity_kwh"], "npv_gain": best["npv_gain"], "payback_years": pb,
            "first_year_gain": best["first_year_gain"], "investment": best["investment"], "reasons": reasons, "life_years": life}


def _avg_day(idx: pd.DatetimeIndex, arrays: dict[str, np.ndarray], step: int, months=None) -> dict[str, list[float]]:
    """Average kW at every hour of the day (0..23), for the given months (None = the whole year)."""
    mask = np.ones(len(idx), bool) if months is None else np.isin(idx.month.to_numpy(), months)
    hour = idx.hour.to_numpy()[mask]
    per_hour = 60.0 / step                                   # kWh per step -> kW
    out = {}
    for name, v in arrays.items():
        sums = np.bincount(hour, weights=v[mask], minlength=24)
        cnt = np.maximum(np.bincount(hour, minlength=24), 1)
        out[name] = [round(float(x) * per_hour, 3) for x in sums / cnt]
    return out


def analyse(inputs: dict, b: BatteryParams, data: dict, sizes: list[float] | None = None, years: int | None = None) -> dict:
    """Is a battery worth it on these data? inputs: the answer of build_inputs. data: the arguments of finance.FinanceParams (kwp and the
    prices/rates of the finance step). sizes: the capacities to try (None = a sweep). Returns the sizes, the verdict, and for the best
    size the balance of the year, the months, the average days and the daily totals."""
    load_s, pv_s, step = inputs["load"], inputs["pv"], inputs["step_minutes"]
    idx = load_s.index
    load, pv = load_s.to_numpy(float), pv_s.to_numpy(float)
    days = len(load) * step / 1440.0
    af = 365.0 / days          # 1 for a whole year; a period alone (fill_year False) is scaled to a year
    years = int(years or data.get("lifetime_years", 25))
    data = {**data, "lifetime_years": years}
    annual_load = float(load.sum()) * af
    sweep_sizes = [c for c in sizes_for(annual_load / 365.0, sizes) if c >= battery.MIN_CARD_KWH - 1e-9] or sizes_for(annual_load / 365.0, sizes)
    out: dict = {"step_minutes": step, "days": round(days, 1), "annual_factor": round(af, 4), "notes": inputs["notes"],
                 "pv_source": inputs["pv_source"], "load_source": inputs["load_source"],
                 "period": {"start": idx[0].isoformat(), "end": (idx[-1] + pd.Timedelta(minutes=step)).isoformat()},
                 "coverage": inputs.get("coverage")}
    direct = np.minimum(pv, load)
    prod_year, load_year = float(pv.sum()) * af, annual_load
    base = {"production_kwh": round(prod_year, 1), "consumption_kwh": round(load_year, 1),
            "direct_kwh": round(float(direct.sum()) * af, 1), "export_kwh": round(float((pv - direct).sum()) * af, 1),
            "import_kwh": round(float((load - direct).sum()) * af, 1)}
    base["self_consumption_pct"] = round(100.0 * base["direct_kwh"] / prod_year, 1) if prod_year > 0 else 0.0
    base["autarky_pct"] = round(100.0 * base["direct_kwh"] / load_year, 1) if load_year > 0 else 0.0
    base["export_pct_of_production"] = round(100.0 - base["self_consumption_pct"], 1) if prod_year > 0 else 0.0
    out["base"] = base
    out["savings_possible"] = b.reserve_pct < 100.0
    if not out["savings_possible"] or prod_year <= 0:
        out.update(sweep=[], best=None, verdict=_verdict(None, base, b, data, years), detail=None)
        return out
    sts = storages_for_sizes(pv, load, step, b, sweep_sizes, years, float(data.get("degradation_pct", 0.5)), af)
    rows = [_finance_row(c, sts[c], b, data, annual_load, step, _power_kw(b, c)) for c in sweep_sizes]
    out["sweep"] = rows
    best = max(rows, key=lambda r: r["npv_gain"])
    out["best"] = best
    out["verdict"] = _verdict(best, base, b, data, years)
    # the where and when, for the size with the best gain (or the least bad one)
    c = best["capacity_kwh"]
    run = battery_sim.dispatch(pv, load, c, b.usable_pct, b.roundtrip_pct, _power_kw(b, c) * step / 60.0, b.reserve_pct, series=True)
    imp_w, exp_w = load - direct, pv - direct
    imp_b = imp_w - run["discharge"]
    exp_b = exp_w - run["charge"]
    m = idx.month.to_numpy() - 1

    def monthly(v):
        return np.bincount(m, weights=v, minlength=12) * af
    mon = {k: monthly(v) for k, v in {"load": load, "pv": pv, "import_without": imp_w, "import_with": imp_b, "export_without": exp_w,
                                       "export_with": exp_b, "shifted": run["discharge"]}.items()}
    retail, sell = float(data.get("retail_price", 0.2)), float(data.get("export_price", 0.07))
    scheme = data.get("scheme", "net_billing")
    months = []
    for i in range(12):
        row = {"month": i + 1, **{k: round(float(v[i]), 1) for k, v in mon.items()}}
        row["gain_eur"] = None if scheme == "net_metering" else round(
            (mon["import_without"][i] - mon["import_with"][i]) * retail - (mon["export_without"][i] - mon["export_with"][i]) * (sell if scheme == "net_billing" else 0.0), 2)
        months.append(row)
    soc_pct = run["stored"] / run["capacity_used"] * 100.0 if run["capacity_used"] > 0 else np.zeros(len(load))
    day_arrays = {"load": load, "pv": pv, "charge": run["charge"], "discharge": run["discharge"], "import_without": imp_w,
                  "import_with": imp_b, "export_without": exp_w, "export_with": exp_b, "soc_pct": soc_pct / (60.0 / step)}
    profiles = {"year": _avg_day(idx, day_arrays, step), "winter": _avg_day(idx, day_arrays, step, [12, 1, 2]),
                "summer": _avg_day(idx, day_arrays, step, [6, 7, 8])}
    for p in profiles.values():
        p["soc_pct"] = [round(v * 1.0, 1) for v in p["soc_pct"]]    # already a percentage (not per hour)
    day_key = idx.normalize()
    codes, uniq = pd.factorize(day_key)
    daily = {"date": [d.strftime("%Y-%m-%d") for d in uniq]}
    for name, v in {"load": load, "pv": pv, "import_with": imp_b, "import_without": imp_w, "export_with": exp_b, "export_without": exp_w}.items():
        daily[name] = [round(float(x), 2) for x in np.bincount(codes, weights=v)]
    # when the battery works: how many days it charges / empties, and the hours it is busiest
    out["detail"] = {
        "capacity_kwh": c, "power_kw": round(_power_kw(b, c), 2), "usable_kwh": round(run["capacity_used"], 2),
        "with": {"import_kwh": round(float(imp_b.sum()) * af, 1), "export_kwh": round(float(exp_b.sum()) * af, 1),
                 "self_consumption_pct": best["self_consumption_pct"], "autarky_pct": best["autarky_pct"],
                 "charged_kwh": round(float(run["charge"].sum()) * af, 1), "discharged_kwh": round(float(run["discharge"].sum()) * af, 1),
                 "cycles": round(float(run["cycles"]) * af, 1)},
        "ceiling_shift_kwh": round(min(base["export_kwh"], base["import_kwh"]), 1),
        "months": months, "day_profiles": profiles, "daily": daily,
        "peak_load_kw": round(float(load.max()) * 60.0 / step, 2),
    }
    return out
