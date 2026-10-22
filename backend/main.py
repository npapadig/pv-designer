"""PV Designer web server. Run with:  python -m uvicorn backend.main:app"""
from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Literal

from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import electrical, energy, finance, report, settings, shading, simulation, storage
from .equipment import INVERTERS, Inverter
from .layout import LayoutParams, compute_faces_layout, compute_layout, split_area

# Windows may not know these types; set them so the browser gets the right header.
mimetypes.add_type("font/woff2", ".woff2")
# The Windows registry can map .css/.js to text/plain, and browsers then ignore the file.
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("text/javascript", ".js")

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
VERSION = (ROOT_DIR / "VERSION").read_text(encoding="utf-8").strip()

app = FastAPI(title="PV Designer", version=VERSION)


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


class FaceArea(BaseModel):
    """One roof face: its outline and, optionally, its own tilt and azimuth (else the common ones)."""
    area: list[list[float]] = Field(..., description="[[lat, lng], ...]")
    tilt_deg: float | None = Field(None, ge=0, le=90)
    azimuth_deg: float | None = Field(None, ge=0, le=360)


class FacesLayoutRequest(LayoutRequest):
    area: list[list[float]] = []  # unused; the faces carry the outlines
    faces: list[FaceArea] = Field(..., min_length=1)


class SplitRequest(BaseModel):
    area: list[list[float]] = Field(..., description="[[lat, lng], ...]")
    line: list[list[float]] = Field(..., description="[[lat, lng], ...], the cut (e.g. the ridge)")


class Face(BaseModel):
    tilt_deg: float = Field(..., ge=0, le=90)
    azimuth_deg: float = Field(..., ge=0, le=360)


class EnergyFace(Face):
    kwp: float = Field(..., ge=0)
    shading_monthly_pct: list[float] | None = Field(None, min_length=12, max_length=12)


class EnergyRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    kwp: float = Field(..., gt=0)
    tilt_deg: float = Field(30, ge=0, le=90)
    azimuth_deg: float = Field(180, ge=0, le=360)
    loss_pct: float = Field(14, ge=0, le=60)
    source: Literal["auto", "pvgis", "offline"] = "auto"
    shading_monthly_pct: list[float] | None = Field(None, min_length=12, max_length=12)
    faces: list[EnergyFace] | None = None  # roof faces; then kwp/tilt/azimuth/shading come from each face


class Obstacle(BaseModel):
    polygon: list[list[float]]
    height_m: float = Field(0, ge=0, le=500)


class ShadingRequest(BaseModel):
    panels: list[list[list[float]]]
    obstacles: list[Obstacle] = []
    tilt_deg: float = Field(30, ge=0, le=90)
    azimuth_deg: float = Field(180, ge=0, le=360)
    mounting: Literal["flush", "rack"] = "flush"
    faces: list[Face] | None = None        # roof faces with their own tilt/azimuth
    panel_face: list[int] | None = None    # face index of each panel (needed with faces)


class ShadowsRequest(ShadingRequest):
    when: str = Field(..., description="ISO date-time, e.g. 2025-12-21T10:00:00Z")


class FinanceRequest(BaseModel):
    kwp: float = Field(..., gt=0)
    annual_kwh: float = Field(..., gt=0)
    capex_per_kwp: float = Field(1100, ge=0, le=10000)
    subsidy_eur: float = Field(0, ge=0)
    scheme: Literal["self", "net_billing", "net_metering"] = "net_billing"
    self_consumption_pct: float = Field(40, ge=0, le=100)
    annual_consumption_kwh: float | None = Field(None, ge=0)
    retail_price: float = Field(0.20, ge=0, le=2)
    export_price: float = Field(0.07, ge=0, le=2)
    offset_price: float = Field(0.16, ge=0, le=2)
    price_escalation_pct: float = Field(2, ge=-10, le=20)
    degradation_pct: float = Field(0.5, ge=0, le=5)
    om_per_kwp: float = Field(12, ge=0, le=500)
    om_escalation_pct: float = Field(2, ge=-10, le=20)
    inverter_replacement_year: int = Field(12, ge=0, le=40)
    inverter_cost_per_kwp: float = Field(120, ge=0, le=2000)
    discount_rate_pct: float = Field(5, ge=0, le=30)
    lifetime_years: int = Field(25, ge=1, le=40)


class ElectricalRequest(BaseModel):
    module: electrical.Module
    n_modules: int = Field(..., ge=1, le=100000)
    inverter: Inverter | None = None
    n_inverters: int | None = Field(None, ge=1, le=1000)
    modules_per_string: int | None = Field(None, ge=1, le=100)
    t_min: float = Field(-10, ge=-50, le=30)
    t_max: float = Field(40, ge=0, le=60)
    mounting: Literal["flush", "rack"] = "rack"
    dc_ac_target: float = Field(1.2, ge=0.5, le=2)
    phases: Literal["auto", "1", "3"] = "auto"
    face_modules: list[int] | None = Field(None, max_length=200)  # panels on each roof face
    mix_faces: bool = False  # allow strings across faces (not recommended)


class SimulationRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    tilt_deg: float = Field(30, ge=0, le=90)
    azimuth_deg: float = Field(180, ge=0, le=360)
    dc_kwp: float = Field(..., gt=0)
    ac_kw: float = Field(..., gt=0)
    inverter_eff_pct: float = Field(98, gt=50, le=100)
    temp_coeff_pmax_pct: float = Field(-0.35, ge=-1, le=0)
    mounting: Literal["flush", "rack"] = "rack"
    soiling_pct: float = Field(2, ge=0, le=30)
    mismatch_pct: float = Field(2, ge=0, le=20)
    module_quality_pct: float = Field(1, ge=-5, le=20)
    dc_wiring_pct: float = Field(1.5, ge=0, le=20)
    ac_wiring_pct: float = Field(0.5, ge=0, le=20)
    availability_pct: float = Field(0, ge=0, le=50)
    shading_monthly_pct: list[float] | None = Field(None, min_length=12, max_length=12)
    faces: list[EnergyFace] | None = None  # roof faces on this inverter; their kwp give each one's share


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/version")
def version():
    return {"version": VERSION}


class SettingsUpdate(BaseModel):
    google_maps_key: str | None = Field(None, max_length=200)


@app.get("/api/settings")
def settings_get():
    return settings.load()


@app.put("/api/settings")
def settings_put(req: SettingsUpdate):
    changes = {k: v.strip() for k, v in req.model_dump().items() if v is not None}
    return settings.save(changes)


@app.post("/api/layout")
def layout(req: LayoutRequest):
    params = LayoutParams(**req.model_dump(exclude={"area"}))
    try:
        return compute_layout(req.area, params)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/layout/faces")
def layout_faces(req: FacesLayoutRequest):
    params = LayoutParams(**req.model_dump(exclude={"area", "faces"}))
    try:
        return compute_faces_layout([f.model_dump() for f in req.faces], params)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/split")
def split_roof(req: SplitRequest):
    try:
        return {"pieces": split_area(req.area, req.line)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/energy")
def energy_estimate(req: EnergyRequest):
    if req.faces:
        try:
            return energy.estimate_faces(req.lat, req.lon, [f.model_dump() for f in req.faces], req.loss_pct, req.source)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(502, str(e))
    try:
        result = energy.estimate(req.lat, req.lon, req.kwp, req.tilt_deg, req.azimuth_deg, req.loss_pct, req.source)
    except Exception as e:
        raise HTTPException(502, str(e))
    if req.shading_monthly_pct:
        result = energy.apply_shading(result, req.shading_monthly_pct, req.kwp)
    return result


def _faces(req) -> list[dict] | None:
    return [f.model_dump() for f in req.faces] if req.faces else None


@app.post("/api/shading")
def shading_analysis(req: ShadingRequest):
    try:
        return shading.analyze(req.panels, [o.model_dump() for o in req.obstacles],
                               req.tilt_deg, req.azimuth_deg, req.mounting, _faces(req), req.panel_face)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/shadows")
def shadows(req: ShadowsRequest):
    try:
        return shading.shadows_at(req.panels, [o.model_dump() for o in req.obstacles],
                                  req.tilt_deg, req.azimuth_deg, req.mounting, req.when, _faces(req), req.panel_face)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/finance")
def finance_analysis(req: FinanceRequest):
    try:
        return finance.analyse(finance.FinanceParams(**req.model_dump()))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/inverters")
def inverters():
    return [i.model_dump() for i in INVERTERS]


@app.post("/api/electrical")
def electrical_design(req: ElectricalRequest):
    try:
        return electrical.design(**req.model_dump(exclude={"module", "inverter"}), module=req.module, inverter=req.inverter)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/simulate")
def simulate(req: SimulationRequest):
    args = req.model_dump()
    args["tilt"], args["azimuth"] = args.pop("tilt_deg"), args.pop("azimuth_deg")
    if args["faces"]:
        args["faces"] = [{"dc_kwp": f["kwp"], "tilt": f["tilt_deg"], "azimuth": f["azimuth_deg"],
                          "shading_monthly_pct": f["shading_monthly_pct"]} for f in args["faces"]]
    try:
        return simulation.simulate(**args)
    except ValueError as e:
        raise HTTPException(400, str(e))
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


def _pdf_response(project: dict, lang: str = "el") -> Response:
    if not project.get("areas") and not (project.get("layout") or {}).get("panels"):
        raise HTTPException(400, "Σχεδίασε πρώτα μια περιοχή και τοποθέτησε πάνελ.")
    pdf = report.build_pdf(project, lang=lang)
    name = quote(report.filename(project, lang))
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename=report.pdf; filename*=UTF-8''{name}"})


@app.post("/api/report")
def report_from_data(data: dict):
    """PDF report of the project as currently shown (saved or not); "lang": "en" for English."""
    return _pdf_response(data, data.get("lang") or "el")


@app.get("/api/projects/{project_id}/report")
def project_report(project_id: str, lang: str = "el"):
    try:
        return _pdf_response(storage.get_project(project_id), lang)
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")


# ---------- Floor plans (start screen / plan.js) ----------
from fastapi import Request  # noqa: E402  (kept with the plan routes)
from fastapi.responses import FileResponse  # noqa: E402


@app.post("/api/plans")
async def plan_upload(request: Request):
    """The image arrives as the raw request body (no form upload library needed)."""
    data = await request.body()
    if len(data) > storage.MAX_PLAN_BYTES:
        raise HTTPException(413, "Η εικόνα είναι πολύ μεγάλη (πάνω από 25 MB).")
    try:
        return {"id": storage.save_plan(data)}
    except ValueError:
        raise HTTPException(400, "Η κάτοψη πρέπει να είναι εικόνα PNG ή JPG.")


@app.get("/api/plans/{plan_id}")
def plan_get(plan_id: str):
    try:
        path = storage.plan_path(plan_id)
    except KeyError:
        raise HTTPException(404, "Η κάτοψη δεν βρέθηκε.")
    media = "image/png" if path.suffix == ".png" else "image/jpeg"
    return FileResponse(path, media_type=media, headers={"Cache-Control": "max-age=86400"})


# ---------- Ready-made layout proposals (stream "options") ----------
from .layout import compute_ew_areas, layout_options  # noqa: E402


class OptionsRequest(LayoutRequest):
    area: list[list[float]] = []  # unused; the areas carry the outlines
    areas: list[list[list[float]]] = Field(..., min_length=1)
    east_west: bool = False  # the manual proposal uses east-west racks (the "Ανατολή-δύση" switch)


@app.post("/api/layout/options")
def layout_options_route(req: OptionsRequest):
    # The cards compare installed power and how well each placement catches the sun (Νίκος, 2026-10-22):
    # no energy estimate and no PVGIS call here.
    params = LayoutParams(**req.model_dump(exclude={"area", "areas", "east_west"}))
    try:
        options = layout_options(req.areas, params, req.east_west)
    except ValueError as e:
        raise HTTPException(400, str(e))
    lat, lon = options[0]["center"]
    planes = [[(f["tilt_deg"], f["azimuth_deg"], f["kwp"] or 1.0) for f in o["faces"]] if o.get("faces")
              else [(o["tilt_deg"], o["azimuth_deg"], 1.0)] for o in options]
    yields = simulation.orientation_yield(lat, lon, planes)
    for o, pct in zip(options, yields["pct"]):
        o["yield_pct"] = pct
    return {"options": options, "yield_source": yields["source"]}


class AreasLayoutRequest(LayoutRequest):
    area: list[list[float]] = []  # unused; the areas carry the outlines
    areas: list[list[list[float]]] = Field(..., min_length=1)


@app.post("/api/layout/ew")
def layout_east_west(req: AreasLayoutRequest):
    """East-west racks back to back over all areas: two faces (0 = east, 1 = west), like /api/layout/faces."""
    params = LayoutParams(**req.model_dump(exclude={"area", "areas"}))
    try:
        return compute_ew_areas(req.areas, params)
    except ValueError as e:
        raise HTTPException(400, str(e))


# The page links its own CSS and JS with ?v=<version>, so a browser that cached the files of
# an older version fetches the new ones after an update. no-cache makes it check every time.
@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index_page():
    html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8").replace("__VERSION__", VERSION)
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
