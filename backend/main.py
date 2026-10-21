"""PV Designer web server. Run with:  python -m uvicorn backend.main:app"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import energy, report, storage
from .layout import LayoutParams, compute_layout

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="PV Designer")


class LayoutRequest(BaseModel):
    area: list[list[float]] = Field(..., description="[[lat, lng], ...]")
    keepouts: list[list[list[float]]] = []
    panel_width_m: float = Field(1.134, gt=0.2, lt=5)
    panel_length_m: float = Field(1.722, gt=0.2, lt=5)
    panel_power_w: float = Field(410, gt=0, lt=2000)
    orientation: Literal["portrait", "landscape"] = "portrait"
    azimuth_deg: float = Field(180, ge=0, le=360)
    tilt_deg: float = Field(30, ge=0, le=90)
    mounting: Literal["flush", "rack"] = "flush"
    row_spacing_m: float | None = Field(None, ge=0, le=20)
    col_spacing_m: float = Field(0.02, ge=0, le=5)
    setback_m: float = Field(0.5, ge=0, le=20)


class EnergyRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    kwp: float = Field(..., gt=0)
    tilt_deg: float = Field(30, ge=0, le=90)
    azimuth_deg: float = Field(180, ge=0, le=360)
    loss_pct: float = Field(14, ge=0, le=60)
    source: Literal["auto", "pvgis", "offline"] = "auto"


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/layout")
def layout(req: LayoutRequest):
    params = LayoutParams(**req.model_dump(exclude={"area"}))
    try:
        return compute_layout(req.area, params)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/energy")
def energy_estimate(req: EnergyRequest):
    try:
        return energy.estimate(req.lat, req.lon, req.kwp, req.tilt_deg, req.azimuth_deg, req.loss_pct, req.source)
    except Exception as e:
        raise HTTPException(502, str(e))


@app.get("/api/projects")
def projects_list():
    return storage.list_projects()


@app.get("/api/projects/{project_id}")
def project_get(project_id: str):
    try:
        return storage.get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")


@app.post("/api/projects")
def project_create(data: dict):
    data.pop("id", None)
    return storage.save_project(data)


@app.put("/api/projects/{project_id}")
def project_update(project_id: str, data: dict):
    try:
        return storage.save_project(data, project_id)
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")


@app.delete("/api/projects/{project_id}")
def project_delete(project_id: str):
    try:
        storage.delete_project(project_id)
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")
    return {"ok": True}


def _pdf_response(project: dict) -> Response:
    if not project.get("areas") and not (project.get("layout") or {}).get("panels"):
        raise HTTPException(400, "Σχεδίασε πρώτα μια περιοχή και τοποθέτησε πάνελ.")
    pdf = report.build_pdf(project)
    name = quote(report.filename(project))
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=report.pdf; filename*=UTF-8''{name}"})


@app.post("/api/report")
def report_from_data(data: dict):
    """PDF report of the project as currently shown (saved or not)."""
    return _pdf_response(data)


@app.get("/api/projects/{project_id}/report")
def project_report(project_id: str):
    try:
        return _pdf_response(storage.get_project(project_id))
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
