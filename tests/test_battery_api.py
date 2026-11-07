"""The web interface of the battery-on-real-data feature (backend/battery_api.py), on a small app of its own with a made-up forecast."""
import base64

import numpy as np
import pandas as pd
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import battery_api, battery_data

LAT, LON = 37.98, 23.72
UTC = pd.date_range("2005-01-01", "2005-12-31 23:00", freq="h", tz="UTC")
_h = UTC.hour.to_numpy()
FORECAST = pd.Series(np.clip(np.sin((_h - 3) / 12 * np.pi), 0, None) * (0.5 + 0.5 * np.sin((UTC.dayofyear.to_numpy() - 80) / 365 * 2 * np.pi)) * 4.0,
                     index=UTC)


def _hourly_pv(sim):
    return FORECAST, {"lat": LAT, "lon": LON, "warning": None}


app = FastAPI()
app.include_router(battery_api.make_router(_hourly_pv))
client = TestClient(app)

IDX = pd.date_range("2025-01-01", "2025-12-31 23:00", freq="h")
_hh = IDX.hour.to_numpy()
LOAD = 0.3 + 0.5 * np.exp(-((_hh - 20) / 2.5) ** 2) + 0.2 * np.exp(-((_hh - 8) / 2) ** 2)


def _file(values, name="load.csv", head="Ημερομηνία;Κατανάλωση (kWh)"):
    lines = [head] + [f"{t:%d/%m/%Y %H:%M};{v:.3f}".replace(".", ",") for t, v in zip(IDX, values)]
    return {"filename": name, "content_b64": base64.b64encode("\n".join(lines).encode("utf-8")).decode()}


def test_parse_endpoint_describes_the_file_and_the_shape_of_the_consumption():
    r = client.post("/api/battery/data/parse", json=_file(LOAD))
    assert r.status_code == 200
    j = r.json()
    assert j["step_minutes"] == 60 and j["days"] == 365 and abs(j["annual_kwh"] - LOAD.sum()) < 1
    assert len(j["avg_day_kw"]["year"]) == 24 and len(j["monthly_kwh"]) == 12 and "series" not in j
    assert j["avg_day_kw"]["year"][20] > j["avg_day_kw"]["year"][3]


def test_a_bad_file_gets_a_plain_greek_message_not_a_crash():
    r = client.post("/api/battery/data/parse", json={"filename": "x.csv", "content_b64": base64.b64encode(b"hello\nworld\n").decode()})
    assert r.status_code == 400 and "ημερομηνίες" in r.json()["detail"]
    r = client.post("/api/battery/data/parse", json={**_file(LOAD), "unit": "banana"})
    assert r.status_code == 400


def test_analyse_with_the_forecast_gives_sizes_a_verdict_and_details():
    body = {"consumption": _file(LOAD), "simulation": {"dc_kwp": 5.0}, "has_pv": False, "kwp": 5.0,
            "battery": {"reserve_pct": 0, "cost_per_kwh": 300}, "finance": {"scheme": "net_billing", "lifetime_years": 15}}
    r = client.post("/api/battery/data/analyse", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["pv_source"] == "forecast" and j["step_minutes"] == 60 and j["sweep"] and j["verdict"]["code"] in ("yes", "marginal", "no")
    assert j["detail"]["with"]["autarky_pct"] >= j["base"]["autarky_pct"] and len(j["detail"]["daily"]["date"]) == 365
    assert j["consumption_file"]["filename"] == "load.csv"


def test_analyse_with_an_inverter_file_uses_the_measured_production():
    prod = np.clip(np.sin((_hh - 6) / 12 * np.pi), 0, None) * 3.0
    body = {"consumption": _file(LOAD), "production": _file(prod, "inverter.csv", "Ημερομηνία;Παραγωγή (kWh)"), "has_pv": True, "kwp": 4.0,
            "battery": {"reserve_pct": 0}, "finance": {}}
    r = client.post("/api/battery/data/analyse", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["pv_source"] == "measured" and abs(j["base"]["production_kwh"] - prod.sum()) < 2 and j["production_file"]["filename"] == "inverter.csv"


def test_analyse_without_any_production_asks_for_it():
    r = client.post("/api/battery/data/analyse", json={"consumption": _file(LOAD), "has_pv": True, "kwp": 4.0})
    assert r.status_code == 400 and "παραγωγή" in r.json()["detail"]


@pytest.mark.parametrize("step,rows", [("hour", 8760), ("quarter", 35040)])
def test_forecast_csv_is_a_clean_typical_year_and_reads_back_into_the_same_numbers(step, rows):
    r = client.post("/api/production/csv", json={"simulation": {"dc_kwp": 5.0}, "step": step})
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    data = r.content
    parsed = battery_data.parse(data, "p.csv")
    assert parsed["kind"] == "production" and len(parsed["series"]["import"]) == rows and parsed["missing_pct"] == 0
    assert abs(parsed["annual_kwh"] - FORECAST.sum()) / FORECAST.sum() < 0.01        # the same year, now on a clean local clock
    first = data.decode("utf-8-sig").splitlines()[2]
    assert first.startswith("01/01/2025 00:00;")


def test_a_file_with_only_part_of_the_year_tells_the_user_to_send_the_rest():
    half = IDX[IDX < "2025-08-01"]
    lines = ["Ημερομηνία;Κατανάλωση (kWh)"] + [f"{t:%d/%m/%Y %H:%M};1,5" for t in half]
    f = {"filename": "mixed.csv", "content_b64": base64.b64encode("\n".join(lines).encode()).decode()}
    p = client.post("/api/battery/data/parse", json=f).json()
    assert p["full_year"] is False and any(m["code"] == "send_rest_of_year" for m in p["messages"])
    r = client.post("/api/battery/data/analyse", json={"consumption": f, "simulation": {"dc_kwp": 5.0}, "has_pv": False, "kwp": 5.0,
                                                       "battery": {"reserve_pct": 0}, "finance": {}})
    assert r.status_code == 200, r.text
    j = r.json()
    texts = " ".join(m["text"] for m in j["messages"])
    assert j["coverage"]["real_pct"] < 60 and "στείλε και τις υπόλοιπες μετρήσεις του έτους" in texts and "Αύγ" in texts
    # the rest of the year as a second file: no more completion, no message
    rest = ["Ημερομηνία;Κατανάλωση (kWh)"] + [f"{t:%d/%m/%Y %H:%M};1,5" for t in IDX[IDX >= "2025-08-01"]]
    f2 = {"filename": "rest.csv", "content_b64": base64.b64encode("\n".join(rest).encode()).decode()}
    r2 = client.post("/api/battery/data/analyse", json={"consumption": f, "more_consumption": [f2], "simulation": {"dc_kwp": 5.0}, "has_pv": False,
                                                        "kwp": 5.0, "battery": {"reserve_pct": 0}, "finance": {}})
    j2 = r2.json()
    assert r2.status_code == 200 and j2["coverage"] is None and not any(m["code"] == "send_rest_of_year" for m in j2["messages"])
    assert "merged_files" in j2["notes"] or any(m["code"] == "merged_files" for m in j2["messages"])
