"""Energy yield estimate.

Primary source: PVGIS (EU Joint Research Centre), which uses satellite
irradiance data for the exact location. If PVGIS cannot be reached (no
internet), fall back to an offline pvlib clear-sky model scaled by a typical
cloudiness factor. The fallback is rough and is labelled as such.
"""
from __future__ import annotations

import httpx

PVGIS_URLS = [
    "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc",
    "https://re.jrc.ec.europa.eu/api/v5_2/PVcalc",
]

# Share of clear-sky irradiation that typically reaches the ground over a year.
# Roughly 0.75 for southern Europe; used only by the offline fallback.
OFFLINE_CLOUD_FACTOR = 0.75


def pvgis_estimate(lat, lon, kwp, tilt, azimuth, loss_pct, timeout=30.0) -> dict:
    params = {
        "lat": lat,
        "lon": lon,
        "peakpower": kwp,
        "loss": loss_pct,
        "angle": tilt,
        "aspect": azimuth - 180.0,  # PVGIS: 0=south, -90=east, 90=west
        "mountingplace": "building",
        "outputformat": "json",
    }
    last_err = None
    for url in PVGIS_URLS:
        try:
            r = httpx.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return parse_pvgis(r.json(), kwp, loss_pct)
        except Exception as e:  # try the next API version
            last_err = e
    raise RuntimeError(f"PVGIS δεν απάντησε: {last_err}")


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def parse_pvgis(data: dict, kwp: float, loss_pct: float | None = None) -> dict:
    out = data["outputs"]
    monthly = [
        {"month": int(m["month"]), "kwh": round(float(m["E_m"]), 1), "irradiation": round(float(m["H(i)_m"]), 1)}
        for m in out["monthly"]["fixed"]
    ]
    # PVGIS sometimes sends numbers as text (e.g. l_spec "0.46"), so read every total as a float.
    totals = {k: _num(v) for k, v in out["totals"]["fixed"].items()}
    annual = totals["E_y"]
    return {
        "source": "PVGIS",
        "annual_kwh": round(annual, 0),
        "specific_yield": round(annual / kwp, 0) if kwp else 0,
        "monthly": monthly,
        "annual_irradiation": round(totals.get("H(i)_y", 0), 0),
        "total_losses_pct": round(totals.get("l_total", 0), 1),
        # Loss steps in %, positive = energy lost (PVGIS reports them as negative changes).
        "losses": {
            "aoi": round(-totals.get("l_aoi", 0), 2),
            "spectral": round(-totals.get("l_spec", 0), 2),
            "temperature": round(-totals.get("l_tg", 0), 2),
            "system": loss_pct,
        },
    }


def offline_estimate(lat, lon, kwp, tilt, azimuth, loss_pct, year=2023) -> dict:
    # Imported here so the app still starts if pvlib is missing; only this fallback needs it.
    import pandas as pd
    import pvlib

    times = pd.date_range(f"{year}-01-01", f"{year + 1}-01-01", freq="1h", tz="UTC", inclusive="left")
    loc = pvlib.location.Location(lat, lon)
    solpos = loc.get_solarposition(times)
    cs = loc.get_clearsky(times, model="ineichen", solar_position=solpos)
    poa = pvlib.irradiance.get_total_irradiance(
        tilt, azimuth, solpos["apparent_zenith"], solpos["azimuth"],
        cs["dni"], cs["ghi"], cs["dhi"], model="isotropic",
    )["poa_global"].clip(lower=0) * OFFLINE_CLOUD_FACTOR

    # Simple cell temperature correction (-0.4 %/°C, ambient 20 °C).
    t_cell = 20.0 + poa * 0.03
    temp_factor = 1 - 0.004 * (t_cell - 25.0)
    dc_kwh = kwp * poa / 1000.0
    ac_kwh = dc_kwh * temp_factor * (1 - loss_pct / 100.0)
    temp_loss = 1 - float((dc_kwh * temp_factor).sum() / dc_kwh.sum())

    monthly_e = ac_kwh.groupby(ac_kwh.index.month).sum()
    monthly_h = (poa / 1000.0).groupby(poa.index.month).sum()
    monthly = [
        {"month": int(m), "kwh": round(float(monthly_e[m]), 1), "irradiation": round(float(monthly_h[m]), 1)}
        for m in monthly_e.index
    ]
    annual = float(ac_kwh.sum())
    return {
        "source": "offline",
        "annual_kwh": round(annual, 0),
        "specific_yield": round(annual / kwp, 0) if kwp else 0,
        "monthly": monthly,
        "annual_irradiation": round(float(poa.sum() / 1000.0), 0),
        "total_losses_pct": loss_pct,
        "losses": {"temperature": round(temp_loss * 100, 2), "system": loss_pct},
    }


def apply_shading(result: dict, monthly_loss_pct: list, kwp: float) -> dict:
    """Reduce each month's production by that month's shading loss."""
    monthly = []
    for m in result["monthly"]:
        loss = monthly_loss_pct[m["month"] - 1] / 100.0
        monthly.append({**m, "kwh": round(m["kwh"] * (1 - loss), 1), "kwh_unshaded": m["kwh"]})
    annual = sum(m["kwh"] for m in monthly)
    before = result["annual_kwh"]
    return {
        **result,
        "monthly": monthly,
        "annual_kwh": round(annual, 0),
        "annual_kwh_unshaded": before,
        "specific_yield": round(annual / kwp, 0) if kwp else 0,
        "shading_loss_pct": round(100 * (1 - annual / before), 1) if before else 0.0,
        "losses": {**result.get("losses", {}), "shading": round(100 * (1 - annual / before), 2) if before else 0.0},
    }


def estimate(lat, lon, kwp, tilt, azimuth, loss_pct=14.0, source="auto") -> dict:
    if kwp <= 0:
        raise ValueError("Η ισχύς πρέπει να είναι μεγαλύτερη από 0.")
    if source in ("auto", "pvgis"):
        try:
            return pvgis_estimate(lat, lon, kwp, tilt, azimuth, loss_pct)
        except Exception as e:
            if source == "pvgis":
                raise
            result = offline_estimate(lat, lon, kwp, tilt, azimuth, loss_pct)
            result["warning"] = (
                "Δεν ήταν δυνατή η σύνδεση με το PVGIS, οπότε έγινε πρόχειρη εκτίμηση "
                f"χωρίς internet. Το αποτέλεσμα είναι λιγότερο ακριβές. ({e})"
            )
            return result
    return offline_estimate(lat, lon, kwp, tilt, azimuth, loss_pct)


def estimate_faces(lat, lon, faces, loss_pct=14.0, source="auto") -> dict:
    """Production of several roof faces, each with its own power, tilt, azimuth and shading.

    faces: [{"kwp", "tilt_deg", "azimuth_deg", "shading_monthly_pct" (optional)}, ...].
    Each face is estimated on its own (PVGIS or offline) and the results are added up;
    "faces" in the result keeps the numbers of each face.
    """
    parts = []
    for i, f in enumerate(faces):
        if f["kwp"] <= 0:
            continue
        f = {**f, "face": i}
        r = estimate(lat, lon, f["kwp"], f["tilt_deg"], f["azimuth_deg"], loss_pct, source)
        if f.get("shading_monthly_pct"):
            r = apply_shading(r, f["shading_monthly_pct"], f["kwp"])
        parts.append((f, r))
    if not parts:
        raise ValueError("Η ισχύς πρέπει να είναι μεγαλύτερη από 0.")
    kwp = sum(f["kwp"] for f, _ in parts)

    def weighted(get):  # average over the faces, weighted by their power
        return sum(f["kwp"] * get(r) for f, r in parts) / kwp

    monthly = []
    for i in range(12):
        m = {
            "month": i + 1,
            "kwh": round(sum(r["monthly"][i]["kwh"] for _, r in parts), 1),
            "irradiation": round(weighted(lambda r: r["monthly"][i]["irradiation"]), 1),
        }
        if any("kwh_unshaded" in r["monthly"][i] for _, r in parts):
            m["kwh_unshaded"] = round(sum(r["monthly"][i].get("kwh_unshaded", r["monthly"][i]["kwh"]) for _, r in parts), 1)
        monthly.append(m)
    annual = sum(r["annual_kwh"] for _, r in parts)
    sources = list(dict.fromkeys(r["source"] for _, r in parts))
    keys = set.intersection(*(set(r.get("losses", {})) for _, r in parts))
    result = {
        "source": " + ".join(sources),
        "annual_kwh": round(annual, 0),
        "specific_yield": round(annual / kwp, 0),
        "monthly": monthly,
        "annual_irradiation": round(weighted(lambda r: r["annual_irradiation"]), 0),
        "total_losses_pct": round(weighted(lambda r: r["total_losses_pct"]), 1),
        "losses": {k: round(weighted(lambda r: r["losses"][k]), 2) for k in sorted(keys)},
        "faces": [
            {"face": f["face"], "kwp": f["kwp"], "tilt_deg": f["tilt_deg"], "azimuth_deg": f["azimuth_deg"],
             "annual_kwh": r["annual_kwh"], "specific_yield": r["specific_yield"],
             "annual_irradiation": r["annual_irradiation"], "shading_loss_pct": r.get("shading_loss_pct", 0.0)}
            for f, r in parts
        ],
    }
    if any("annual_kwh_unshaded" in r for _, r in parts):
        before = sum(r.get("annual_kwh_unshaded", r["annual_kwh"]) for _, r in parts)
        loss = round(100 * (1 - annual / before), 2) if before else 0.0
        result["annual_kwh_unshaded"] = round(before, 0)
        result["shading_loss_pct"] = round(loss, 1)
        result["losses"]["shading"] = loss
    warning = next((r["warning"] for _, r in parts if r.get("warning")), None)
    if warning:
        result["warning"] = warning
    return result
