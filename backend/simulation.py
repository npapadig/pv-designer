"""Detailed hourly simulation with pvlib and an energy loss breakdown.

Weather: a typical meteorological year (TMY) from PVGIS for the exact place,
kept in data/weather/ so later runs work without internet. Without internet
and without a saved copy, a clear-sky year scaled for cloudiness is used and
labelled as such.

Chain, hour by hour: sun position -> irradiance on the panel plane (Perez) ->
shading (monthly loss from the shading analysis) ->
reflection losses (IAM) -> soiling -> cell temperature (PVsyst model) -> DC
power (PVWatts) -> mismatch and module quality -> DC wiring -> inverter
efficiency and clipping -> AC wiring. Each step's energy loss is summed over
the year.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

from .electrical import ABSORPTION, MODULE_EFFICIENCY, U_C
from .energy import OFFLINE_CLOUD_FACTOR

WEATHER_DIR = Path(__file__).resolve().parent.parent / "data" / "weather"
PVGIS_TMY_URLS = [
    "https://re.jrc.ec.europa.eu/api/v5_3/tmy",
    "https://re.jrc.ec.europa.eu/api/v5_2/tmy",
]
YEAR = 2023  # TMY months come from different years; put them on one ordinary year
ALBEDO = 0.2


def _cache_path(lat: float, lon: float) -> Path:
    return WEATHER_DIR / f"tmy_{lat:.2f}_{lon:.2f}.json"


def fetch_pvgis_tmy(lat: float, lon: float, timeout: float = 60.0) -> dict:
    last_err = None
    for url in PVGIS_TMY_URLS:
        try:
            r = httpx.get(url, params={"lat": lat, "lon": lon, "outputformat": "json"}, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # try the next API version
            last_err = e
    raise RuntimeError(f"PVGIS δεν απάντησε: {last_err}")


def parse_pvgis_tmy(data: dict) -> pd.DataFrame:
    df = pd.DataFrame(data["outputs"]["tmy_hourly"])
    t = pd.to_datetime(df["time(UTC)"], format="%Y%m%d:%H%M")
    keep = ~((t.dt.month == 2) & (t.dt.day == 29))
    df, t = df[keep], t[keep]
    idx = pd.to_datetime({"year": YEAR, "month": t.dt.month, "day": t.dt.day, "hour": t.dt.hour, "minute": t.dt.minute})
    out = pd.DataFrame({
        "ghi": df["G(h)"].to_numpy(float),
        "dni": df["Gb(n)"].to_numpy(float),
        "dhi": df["Gd(h)"].to_numpy(float),
        "temp_air": df["T2m"].to_numpy(float),
        "wind_speed": df["WS10m"].to_numpy(float),
    }, index=pd.DatetimeIndex(idx).tz_localize("UTC"))
    return out.sort_index()


def clearsky_weather(lat: float, lon: float) -> pd.DataFrame:
    import pvlib

    times = pd.date_range(f"{YEAR}-01-01", f"{YEAR + 1}-01-01", freq="1h", tz="UTC", inclusive="left")
    cs = pvlib.location.Location(lat, lon).get_clearsky(times, model="ineichen") * OFFLINE_CLOUD_FACTOR
    # Rough temperature: seasonal swing peaking late July, daily swing peaking mid-afternoon (local solar time).
    doy = times.dayofyear.to_numpy()
    solar_hour = (times.hour.to_numpy() + lon / 15.0) % 24
    seasonal = 17.0 - 9.0 * np.cos(2 * np.pi * (doy - 25) / 365.0) - 0.4 * (abs(lat) - 38)
    daily = 5.0 * np.cos(2 * np.pi * (solar_hour - 15) / 24.0)
    return pd.DataFrame({
        "ghi": cs["ghi"], "dni": cs["dni"], "dhi": cs["dhi"],
        "temp_air": seasonal + daily, "wind_speed": 2.0,
    }, index=times)


def get_weather(lat: float, lon: float) -> tuple[pd.DataFrame, str, str | None]:
    """(hourly weather, source label, warning or None)."""
    cache = _cache_path(lat, lon)
    try:
        raw = fetch_pvgis_tmy(lat, lon)
        WEATHER_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(raw), encoding="utf-8")
        return parse_pvgis_tmy(raw), "PVGIS TMY", None
    except Exception as e:
        if cache.exists():
            return parse_pvgis_tmy(json.loads(cache.read_text(encoding="utf-8"))), "PVGIS TMY", None
        return clearsky_weather(lat, lon), "offline", (
            "Δεν ήταν δυνατή η σύνδεση με το PVGIS, οπότε η προσομοίωση έγινε με πρόχειρο καιρό "
            f"χωρίς internet. Το αποτέλεσμα είναι λιγότερο ακριβές. ({e})"
        )


def inverter_efficiency(pdc: np.ndarray, pac0: float, eta_nom: float) -> np.ndarray:
    """PVWatts part-load efficiency curve (no clipping)."""
    pdc0 = pac0 / eta_nom
    zeta = np.clip(pdc / pdc0, 1e-6, None)
    eta = eta_nom / 0.9637 * (-0.0162 * zeta - 0.0059 / zeta + 0.9858)
    return np.where(pdc > 0, np.clip(eta, 0, 1), 0.0)


def simulate(
    lat: float,
    lon: float,
    tilt: float,
    azimuth: float,
    dc_kwp: float,
    ac_kw: float,
    inverter_eff_pct: float = 98.0,
    temp_coeff_pmax_pct: float = -0.35,
    mounting: str = "rack",
    soiling_pct: float = 2.0,
    mismatch_pct: float = 2.0,
    module_quality_pct: float = 1.0,
    dc_wiring_pct: float = 1.5,
    ac_wiring_pct: float = 0.5,
    availability_pct: float = 0.0,
    shading_monthly_pct: list[float] | None = None,
    weather: pd.DataFrame | None = None,
    faces: list[dict] | None = None,
) -> dict:
    """faces (optional): roof faces [{"dc_kwp", "tilt", "azimuth", "shading_monthly_pct"}, ...] on one inverter.
    Their dc_kwp give each face's share; they are scaled so that together they make dc_kwp."""
    import pvlib

    if dc_kwp <= 0 or ac_kw <= 0:
        raise ValueError("Χρειάζονται πάνελ και inverter για την προσομοίωση.")
    source, warning = "provided", None
    if weather is None:
        weather, source, warning = get_weather(lat, lon)
    w = weather
    pdc0 = dc_kwp * 1000.0
    pac0 = ac_kw * 1000.0

    sol = pvlib.solarposition.get_solarposition(w.index, lat, lon)
    dni_extra = pvlib.irradiance.get_extra_radiation(w.index)
    airmass = pvlib.atmosphere.get_relative_airmass(sol["apparent_zenith"])

    # Roof faces with their own tilt and azimuth share one inverter: the DC chain runs per face and
    # the DC power is summed before the inverter. Without faces the whole array is one face.
    multi = bool(faces)
    if multi:
        share = sum(f["dc_kwp"] for f in faces)
        if share <= 0:
            raise ValueError("Χρειάζονται πάνελ και inverter για την προσομοίωση.")
        faces = [{**f, "dc_kwp": f["dc_kwp"] * dc_kwp / share} for f in faces if f["dc_kwp"] > 0]
    else:
        faces = [{"dc_kwp": dc_kwp, "tilt": tilt, "azimuth": azimuth, "shading_monthly_pct": shading_monthly_pct}]
    chains = []
    for f in faces:
        f_pdc0 = f["dc_kwp"] * 1000.0
        f_tilt, f_az, f_shading = f["tilt"], f["azimuth"], f.get("shading_monthly_pct")
        poa = pvlib.irradiance.get_total_irradiance(
            f_tilt, f_az, sol["apparent_zenith"], sol["azimuth"], w["dni"], w["ghi"], w["dhi"],
            dni_extra=dni_extra, airmass=airmass, albedo=ALBEDO, model="perez",
        ).fillna(0.0).clip(lower=0.0)
        aoi = pvlib.irradiance.aoi(f_tilt, f_az, sol["apparent_zenith"], sol["azimuth"])
        iam_beam = pvlib.iam.physical(aoi)
        iam_diff = pvlib.iam.marion_diffuse("physical", f_tilt)
        poa_iam = (
            poa["poa_direct"] * iam_beam
            + poa["poa_sky_diffuse"] * iam_diff["sky"]
            + poa["poa_ground_diffuse"] * iam_diff["ground"]
        ).fillna(0.0).clip(lower=0.0)
        # Shading analysis gives a loss per month; it cuts the light reaching the cells.
        shade = np.ones(len(w))
        if f_shading:
            shade = 1 - np.asarray(f_shading, float)[w.index.month.to_numpy() - 1] / 100.0
        poa_iam = poa_iam * shade
        g_eff = poa_iam * (1 - soiling_pct / 100.0)

        t_cell = pvlib.temperature.pvsyst_cell(
            g_eff, w["temp_air"], w["wind_speed"], u_c=U_C.get(mounting, U_C["rack"]), u_v=0.0,
            module_efficiency=MODULE_EFFICIENCY, alpha_absorption=ABSORPTION,
        )

        # Energy after each step, in W per hour of the year.
        steps = {}
        steps["nominal"] = f_pdc0 * poa["poa_global"] / 1000.0
        steps["shading"] = steps["nominal"] * shade
        steps["iam"] = f_pdc0 * poa_iam / 1000.0
        steps["soiling"] = f_pdc0 * g_eff / 1000.0
        steps["temperature"] = pvlib.pvsystem.pvwatts_dc(g_eff, t_cell, f_pdc0, temp_coeff_pmax_pct / 100.0).clip(lower=0)
        steps["mismatch"] = steps["temperature"] * (1 - mismatch_pct / 100.0)
        steps["quality"] = steps["mismatch"] * (1 - module_quality_pct / 100.0)
        p = steps["quality"]
        # Ohmic loss grows with current, so its share scales with power (given at full STC power).
        steps["dc_wiring"] = p * (1 - dc_wiring_pct / 100.0 * p / f_pdc0)
        chains.append({"steps": steps, "poa_global": poa["poa_global"], "t_cell": t_cell})

    steps = {k: sum(c["steps"][k] for c in chains) for k in chains[0]["steps"]}
    if multi:  # irradiance on the panels: average of the faces weighted by their power
        poa_global = sum(f["dc_kwp"] * c["poa_global"] for f, c in zip(faces, chains)) / sum(f["dc_kwp"] for f in faces)
    else:
        poa_global = chains[0]["poa_global"]
    t_cell = pd.concat([c["t_cell"] for c in chains], axis=1).max(axis=1)
    pdc = steps["dc_wiring"].to_numpy()
    pac_raw = pdc * inverter_efficiency(pdc, pac0, inverter_eff_pct / 100.0)
    steps["inverter"] = pd.Series(pac_raw, index=w.index)
    steps["clipping"] = steps["inverter"].clip(upper=pac0)
    pac = steps["clipping"]
    steps["ac_wiring"] = pac * (1 - ac_wiring_pct / 100.0 * pac / pac0)
    steps["availability"] = steps["ac_wiring"] * (1 - availability_pct / 100.0)
    ac = steps["availability"]

    labels = [
        ("shading", "Σκιάσεις"),
        ("iam", "Ανακλάσεις στο τζάμι (γωνία πρόσπτωσης)"),
        ("soiling", "Σκόνη και ρύπανση"),
        ("temperature", "Θερμοκρασία πάνελ"),
        ("mismatch", "Ανομοιογένεια πάνελ (mismatch)"),
        ("quality", "Ποιότητα πάνελ και αρχική υποβάθμιση"),
        ("dc_wiring", "Καλώδια DC"),
        ("inverter", "Απόδοση inverter"),
        ("clipping", "Ψαλίδισμα inverter (clipping)"),
        ("ac_wiring", "Καλώδια AC"),
        ("availability", "Διακοπές λειτουργίας"),
    ]
    totals = {k: float(v.sum()) / 1000.0 for k, v in steps.items()}  # kWh
    losses, prev = [], totals["nominal"]
    for key, label in labels:
        lost = prev - totals[key]
        if not (key in ("availability", "shading") and lost == 0):
            losses.append({
                "key": key, "label": label, "kwh": round(lost, 0),
                "pct": round(100.0 * lost / prev, 2) if prev else 0.0,
            })
        prev = totals[key]

    annual = totals["availability"]
    ghi_kwh_m2 = float(w["ghi"].sum()) / 1000.0
    poa_kwh_m2 = float(poa_global.sum()) / 1000.0
    monthly_e = ac.groupby(ac.index.month).sum() / 1000.0
    monthly_h = poa_global.groupby(poa_global.index.month).sum() / 1000.0
    result = {
        "source": source,
        "method": "detailed",
        "annual_kwh": round(annual, 0),
        "specific_yield": round(annual / dc_kwp, 0),
        "performance_ratio": round(annual / totals["nominal"], 3) if totals["nominal"] else 0,
        "monthly": [
            {"month": int(m), "kwh": round(float(monthly_e[m]), 1), "irradiation": round(float(monthly_h[m]), 1)}
            for m in monthly_e.index
        ],
        "annual_ghi": round(ghi_kwh_m2, 0),
        "annual_irradiation": round(poa_kwh_m2, 0),
        "transposition_gain_pct": round(100.0 * (poa_kwh_m2 / ghi_kwh_m2 - 1), 1) if ghi_kwh_m2 else 0,
        "nominal_kwh": round(totals["nominal"], 0),
        "loss_steps": losses,
        # Same shape as the quick PVGIS estimate (% lost, by group) for code that reads either.
        "losses": {
            "aoi": next(l["pct"] for l in losses if l["key"] == "iam"),
            "temperature": next(l["pct"] for l in losses if l["key"] == "temperature"),
            "system": round(100.0 * (1 - annual / totals["temperature"]), 2) if totals["temperature"] else 0,
        },
        "total_losses_pct": round(100.0 * (1 - annual / totals["nominal"]), 1) if totals["nominal"] else 0,
        "dc_kwp": dc_kwp,
        "ac_kw": ac_kw,
        "clipping_hours": int((steps["inverter"] > pac0 + 1e-6).sum()),
        "max_cell_temp": round(float(t_cell.max()), 1),
        "peak_ac_kw": round(float(pac.max()) / 1000.0, 2),
    }
    if multi:
        shaded = any(f.get("shading_monthly_pct") for f in faces)
        if shaded:
            loss = next((l["pct"] for l in losses if l["key"] == "shading"), 0.0)
            result["losses"]["shading"] = loss
            result["shading_loss_pct"] = round(loss, 1)
            month = steps["nominal"].index.month
            ratio = steps["nominal"].groupby(month).sum() / steps["shading"].groupby(month).sum()
            for m in result["monthly"]:
                r = float(ratio[m["month"]])
                m["kwh_unshaded"] = round(m["kwh"] * r, 1) if np.isfinite(r) else m["kwh"]
            result["annual_kwh_unshaded"] = round(sum(m["kwh_unshaded"] for m in result["monthly"]), 0)
        # Each face's share of the AC energy follows its share of the DC energy into the inverter.
        dc_total = totals["dc_wiring"]
        result["faces"] = []
        for f, c in zip(faces, chains):
            kwh = annual * float(c["steps"]["dc_wiring"].sum()) / 1000.0 / dc_total if dc_total else 0.0
            result["faces"].append({
                "kwp": round(f["dc_kwp"], 3), "tilt_deg": f["tilt"], "azimuth_deg": f["azimuth"],
                "annual_kwh": round(kwh, 0), "specific_yield": round(kwh / f["dc_kwp"], 0),
                "annual_irradiation": round(float(c["poa_global"].sum()) / 1000.0, 0),
            })
    elif shading_monthly_pct:
        loss = next((l["pct"] for l in losses if l["key"] == "shading"), 0.0)
        result["losses"]["shading"] = loss
        result["shading_loss_pct"] = round(loss, 1)
        for m in result["monthly"]:
            f = 1 - shading_monthly_pct[m["month"] - 1] / 100.0
            m["kwh_unshaded"] = round(m["kwh"] / f, 1) if f > 0 else m["kwh"]
        result["annual_kwh_unshaded"] = round(sum(m["kwh_unshaded"] for m in result["monthly"]), 0)
    if warning:
        result["warning"] = warning
    return result
