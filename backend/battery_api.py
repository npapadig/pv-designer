"""The web interface of the battery-on-real-data feature: upload the consumption (and production) files, get the verdict, export the forecast.

Nothing is stored: the page keeps the files and sends them with every request (base64 in JSON); the last few parsed files are cached in memory.
`make_router(hourly_pv)` is mounted by main.py with 2 lines:
    from . import battery_api
    app.include_router(battery_api.make_router(lambda sim: _hourly_pv(SimulationRequest.model_validate(sim).model_dump_json())))
`hourly_pv(simulation: dict) -> (pandas Series of the hourly AC kWh in UTC, {"lat", "lon", ...})`.

Endpoints
- POST /api/battery/data/parse      one file: what was understood (step, period, kind, columns, a preview of the consumption)
- POST /api/battery/data/analyse    the consumption (+ production) file(s), the battery and finance settings: sizes, verdict, details
- POST /api/production/csv          the forecast of the app as a CSV file, every hour or every 15 minutes (a typical year); the file is
                                    readable by `parse` again
"""
from __future__ import annotations

import base64
import binascii
import io

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import battery_data, battery_real
from .battery import BatteryParams

CSV_YEAR = 2025            # the typical year of the forecast is written on the dates of this (not a leap) year


class DataFile(BaseModel):
    filename: str = ""
    content_b64: str = Field(..., description="the file, base64")
    unit: str | None = Field(None, description="kwh | wh | kw | w; None = from the title of the column")
    kind: str | None = Field(None, description="consumption | meter | production; None = guessed")
    label: str | None = Field(None, description="start | end: what the time of a record marks; None = guessed")
    value_col: int | None = None
    export_col: int | None = None

    def parsed(self) -> dict:
        try:
            raw = base64.b64decode(self.content_b64, validate=False)
        except (binascii.Error, ValueError):
            raise ValueError("Το αρχείο δεν ανέβηκε σωστά. Δοκίμασε να το ανεβάσεις ξανά.")
        for name, allowed in (("unit", battery_data.UNITS), ("kind", battery_data.KINDS), ("label", ("start", "end"))):
            v = getattr(self, name)
            if v is not None and v not in allowed:
                raise ValueError(f"Μη έγκυρη τιμή για «{name}».")
        return battery_data.parse_cached(raw, self.filename, self.unit, self.kind, self.label, self.value_col, self.export_col)


class AnalyseRequest(BaseModel):
    consumption: DataFile
    more_consumption: list[DataFile] = Field([], description="further files of the consumption (e.g. the other months of the year), joined with the first")
    injection: DataFile | None = Field(None, description="energy fed into the grid, when the grid operator gives it as a separate file")
    production: DataFile | None = None
    more_production: list[DataFile] = []
    fill_year: bool = Field(True, description="complete a file that covers only part of the year with an estimate")
    simulation: dict | None = Field(None, description="the system, as for /api/simulate: the forecast is used when there is no production file")
    has_pv: bool = Field(True, description="the building already has PV (the meter's numbers are then reduced by it)")
    battery: BatteryParams = BatteryParams()
    finance: dict = {}
    kwp: float = Field(0, ge=0)
    sizes: list[float] | None = None


class CsvRequest(BaseModel):
    simulation: dict
    step: str = Field("hour", pattern="^(hour|quarter)$")


def messages(notes: list[str], coverage: dict | None = None, full_year: bool | None = None, days: float | None = None) -> list[dict]:
    """Plain Greek sentences for what the reading did or could not do (the page shows them; the codes are for the English texts)."""
    out = []
    names = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αύγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"]
    if "year_completed" in notes and coverage:
        est = ", ".join(names[m - 1] for m in coverage["estimated_months"])
        out.append({"code": "send_rest_of_year", "text":
                    f"Το αρχείο έχει μετρήσεις μόνο για {coverage['real_days']:.0f} ημέρες ({coverage['real_pct']:.0f} % του έτους). "
                    f"Τους μήνες που λείπουν ({est}) τους εκτίμησα από τους κοντινότερους μήνες που υπάρχουν. "
                    "Για πιο ακριβή υπολογισμό, στείλε και τις υπόλοιπες μετρήσεις του έτους (ζήτα τις από τον ΔΕΔΔΗΕ) και ανέβασέ τες εδώ."})
    elif full_year is False and days is not None and "partial_period" in notes:
        out.append({"code": "partial_period", "text": f"Το αρχείο έχει μόνο {days:.0f} ημέρες. Το αποτέλεσμα αφορά αυτήν την περίοδο και "
                                                          "μεγαλώνει αναλογικά σε έτος, άρα είναι λιγότερο ακριβές. Στείλε και τις υπόλοιπες μετρήσεις του έτους."})
    elif full_year is False and days is not None:
        out.append({"code": "send_rest_of_year", "text": f"Το αρχείο έχει μόνο {days:.0f} ημέρες. Για πιο ακριβή υπολογισμό στείλε και τις υπόλοιπες "
                                                           "μετρήσεις του έτους (ζήτα τις από τον ΔΕΔΔΗΕ)."})
    texts = {
        "zeros_trimmed": "Αγνόησα τα μηδενικά στο τέλος του αρχείου (μετρήσεις που δεν είχαν έρθει ακόμα).",
        "long_zero_run": "Μεγάλα διαστήματα με μηδέν μέσα στο αρχείο τα θεώρησα ελλιπείς μετρήσεις και τα συμπλήρωσα.",
        "unit_assumed": "Το αρχείο δεν γράφει μονάδα μέτρησης. Υπέθεσα ότι είναι kWh ανά μέτρηση· αν δεν είναι, άλλαξέ το.",
        "end_labeled": "Η ώρα στο αρχείο δείχνει το τέλος κάθε μέτρησης· την έφερα στην αρχή της.",
        "production_estimated": "Δεν υπήρχε αρχείο παραγωγής του inverter: η παραγωγή του υπάρχοντος συστήματος είναι εκτίμηση της εφαρμογής.",
        "production_completed_by_forecast": "Στους μήνες που λείπει η παραγωγή του inverter χρησιμοποίησα την πρόβλεψη της εφαρμογής, προσαρμοσμένη στο τι έδωσε πραγματικά.",
        "different_years": "Η παραγωγή και η κατανάλωση είναι από διαφορετικά έτη· τις αντιστοίχισα ανά ημερομηνία και ώρα.",
        "negative_load_fixed": "Σε κάποιες ώρες η κατανάλωση που βγήκε ήταν αρνητική (πιθανόν μικρή διαφορά ώρας ανάμεσα στα αρχεία)· την έκανα μηδέν.",
        "export_unknown": "Δεν ξέρω πόσο ρεύμα πουλάς στο δίκτυο, γιατί λείπει το αρχείο έγχυσης. Έτσι η κατανάλωση βγαίνει μεγαλύτερη και η περίσσεια μικρότερη από την πραγματική, "
                          "άρα η μπαταρία φαίνεται λιγότερο χρήσιμη απ' όσο είναι. Ανέβασε το αρχείο έγχυσης του ΔΕΔΔΗΕ ή το αρχείο του inverter με την κατανάλωση.",
        "merged_files": "Ένωσα τα αρχεία σε ένα.",
        "injection_partly_missing": "Το αρχείο έγχυσης δεν καλύπτει όλη την περίοδο της κατανάλωσης· όπου λείπει θεωρήθηκε μηδέν.",
    }
    out += [{"code": n, "text": texts[n]} for n in notes if n in texts]
    return out


def _joined(first: DataFile, more: list[DataFile]) -> dict:
    parsed = first.parsed()
    if more:
        parsed = battery_real.merge_parsed([parsed] + [m.parsed() for m in more])
    return parsed


def _preview(parsed: dict) -> dict:
    """What the page shows right after the upload: the shape of the consumption (average day by season, kWh per month)."""
    s = parsed["series"]["import"]
    step = parsed["step_minutes"]
    out = battery_data.summary(parsed)
    hour = s.index.hour.to_numpy()
    month = s.index.month.to_numpy()
    per_hour = 60.0 / step
    days_in_month = np.maximum(np.bincount(month - 1, minlength=12) / (1440.0 / step), 1e-9)

    def avg_day(mask):
        sums = np.bincount(hour[mask], weights=s.to_numpy()[mask], minlength=24)
        cnt = np.maximum(np.bincount(hour[mask], minlength=24), 1)
        return [round(float(v) * per_hour, 3) for v in sums / cnt]
    out["avg_day_kw"] = {"year": avg_day(np.ones(len(s), bool)), "winter": avg_day(np.isin(month, [12, 1, 2])),
                         "summer": avg_day(np.isin(month, [6, 7, 8]))}
    out["messages"] = messages(parsed["notes"], None, parsed["full_year"], parsed["days"])
    out["total_kwh"] = round(float(s.sum()), 1)
    out["monthly_kwh"] = [round(float(v), 1) for v in np.bincount(month - 1, weights=s.to_numpy(), minlength=12)]
    out["daily_kwh_avg_by_month"] = [round(m / d, 2) for m, d in zip(out["monthly_kwh"], days_in_month)]
    return out


def forecast_csv(pv_utc: pd.Series, lat: float, lon: float, step: str = "hour") -> str:
    """The forecast as CSV text: `dd/mm/yyyy hh:mm;kWh` on the local clock of a typical year (8760 rows hourly, 35040 every 15 minutes).
    Semicolons and decimal commas, so a Greek Excel opens it in columns. Every 15 minutes the hour's energy is split evenly (the forecast
    is hourly, so the quarters are not separate predictions)."""
    minutes = 60 if step == "hour" else 15
    grid = pd.date_range(f"{CSV_YEAR}-01-01", f"{CSV_YEAR}-12-31 23:45", freq=f"{minutes}min")
    s = battery_real.on_calendar(battery_real.forecast_local(pv_utc, lat, lon), grid, minutes)
    lines = ["Πρόβλεψη παραγωγής Solly (τυπικό έτος, τοπική ώρα)" + ("" if step == "hour" else " - τα 15λεπτα είναι διαίρεση της ωριαίας τιμής"),
             "Ημερομηνία και ώρα;Παραγωγή (kWh)"]
    lines += [f"{t:%d/%m/%Y %H:%M};{v:.4f}".replace(".", ",") for t, v in zip(grid, s.to_numpy(float))]
    return "\r\n".join(lines) + "\r\n"


def make_router(hourly_pv) -> APIRouter:
    router = APIRouter()

    @router.post("/api/battery/data/parse")
    def data_parse(f: DataFile):
        try:
            return _preview(f.parsed())
        except ValueError as e:
            raise HTTPException(400, str(e))

    @router.post("/api/battery/data/analyse")
    def data_analyse(req: AnalyseRequest):
        try:
            cons = _joined(req.consumption, req.more_consumption)
            prod = _joined(req.production, req.more_production) if req.production else None
            inj = req.injection.parsed() if req.injection else None
            forecast, lat, lon, meta = None, 0.0, 0.0, {}
            if prod is None or req.simulation:
                if req.simulation:
                    forecast, meta = hourly_pv(req.simulation)
                    lat, lon = meta["lat"], meta["lon"]
            if prod is not None and prod["kind"] != "production":
                prod = {**prod, "kind": "production"}
            inputs = battery_real.build_inputs(cons, prod, forecast, lat, lon, has_pv=req.has_pv, injection=inj, fill_year=req.fill_year)
            data = {**req.finance, "kwp": req.kwp or (req.simulation or {}).get("dc_kwp") or 1.0}
            result = battery_real.analyse(inputs, req.battery, data, req.sizes)
        except ValueError as e:
            raise HTTPException(400, str(e))
        result["warning"] = meta.get("warning")
        result["messages"] = messages(result["notes"] + [n for n in cons["notes"] if n not in result["notes"]], result.get("coverage"),
                                      cons["full_year"], cons["days"])
        result["consumption_file"] = {k: cons[k] for k in ("filename", "kind", "step_minutes", "days", "full_year", "covered_months", "missing_pct", "notes")}
        if prod is not None:
            result["production_file"] = {k: prod[k] for k in ("filename", "step_minutes", "days", "full_year", "covered_months", "missing_pct", "notes")}
        return result

    @router.post("/api/production/csv")
    def production_csv(req: CsvRequest):
        try:
            series, meta = hourly_pv(req.simulation)
            text = forecast_csv(series, meta["lat"], meta["lon"], req.step)
        except ValueError as e:
            raise HTTPException(400, str(e))
        name = "prognosi_paragogis_" + ("oraia" if req.step == "hour" else "15lepto") + ".csv"
        return Response(content=("﻿" + text).encode("utf-8"), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    return router
