"""Shading analysis: obstacles with a height and row-to-row shading of rack rows.

Model (in the spirit of HelioScope, simplified):
- Everything is placed in a local metric plane (east, north) with z = height
  above the surface the panels sit on (roof or ground).
- Obstacles are vertical prisms: a drawn footprint extruded to a height.
- Panels on racks are tilted rectangles whose front (low) edge is at z = 0.
  Flush panels lie on the roof surface (z = 0) and cannot shade each other.
- Each panel is sampled with a grid of points. A point at height z is in shade
  when it lies inside the shadow that the parts of objects above z cast on the
  horizontal plane at height z.
- Direct (beam) light: the sun is traced over a representative day of each
  month. Irradiance comes from a clear-sky model scaled for typical cloudiness
  and split into beam and diffuse (Erbs), so cloudy-sky diffuse light, which
  shadows hardly affect, is weighted realistically.
- Diffuse light: the same test is run for directions across the sky dome; the
  blocked share of the (isotropic) sky reduces the diffuse light on each panel.

Shaded energy is counted proportionally to the shaded area of a module; in
reality bypass diodes make partial shade on a module cost somewhat more.
"""
from __future__ import annotations

import math

import numpy as np
import shapely
from pyproj import Transformer
from shapely import affinity
from shapely.geometry import Polygon

from .energy import OFFLINE_CLOUD_FACTOR

MIN_SUN_ELEVATION = 3.0      # below this the sun carries little energy and shadows get endless
TIME_STEP_H = 0.5
SAMPLES_ALONG = 3            # sample rows along the slope of a module
SAMPLES_ACROSS = 3
ALBEDO = 0.2
MAX_SHADOW_M = 300.0
DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _transformers(lat0: float, lon0: float):
    proj = f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +datum=WGS84 +units=m"
    return (Transformer.from_crs("EPSG:4326", proj, always_xy=True),
            Transformer.from_crs(proj, "EPSG:4326", always_xy=True))


def _xy(latlngs, fwd) -> np.ndarray:
    pts = np.asarray(latlngs, dtype=float)
    x, y = fwd.transform(pts[:, 1], pts[:, 0])
    return np.column_stack([x, y])


def _unit(az_deg: float, elev_deg: float) -> np.ndarray:
    a, e = math.radians(az_deg), math.radians(elev_deg)
    return np.array([math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), math.sin(e)])


class Scene:
    """Panels and obstacles in the local metric frame."""

    def __init__(self, panels, obstacles, tilt_deg, azimuth_deg, mounting, fwd, faces=None, panel_face=None):
        # Roof faces: (tilt, azimuth) each; panel_face gives the face of every panel. One face by default.
        n = len(panels)
        self.faces, self.face_idx = _faces(tilt_deg, azimuth_deg, n, faces, panel_face)
        self.tilt = tilt_deg
        self.azimuth = azimuth_deg
        self.normals = [_unit(az, 90.0 - t) for t, az in self.faces]
        self.obstacles = []
        for ob in obstacles:
            h = float(ob.get("height_m") or 0)
            if h > 0 and len(ob["polygon"]) >= 3:
                poly = Polygon(_xy(ob["polygon"], fwd)).buffer(0)
                if not poly.is_empty:
                    self.obstacles.append((poly, h))

        quads = np.array([_xy(p[:4], fwd) for p in panels]).reshape(n, 4, 2)
        # Reorder each quad as F0, F1 (front, low edge), B1, B0 (back, high edge).
        facing = np.array([[math.sin(math.radians(az)), math.cos(math.radians(az))] for _, az in self.faces])
        dots = np.einsum("nij,nj->ni", quads, facing[self.face_idx])
        first = np.argmax(dots + np.roll(dots, -1, axis=1), axis=1)
        idx = (first[:, None] + np.arange(4)) % 4
        c = np.take_along_axis(quads, idx[:, :, None], axis=1)
        self.f0 = c[:, 0]
        self.across = c[:, 1] - c[:, 0]
        self.slope = c[:, 3] - c[:, 0]
        depth = np.linalg.norm(self.slope, axis=1)
        # Back edge height per panel (racks only; flush panels lie on the roof).
        rise = np.array([math.tan(math.radians(t)) if mounting == "rack" and t > 0 else 0.0 for t, _ in self.faces])
        self.height = depth * rise[self.face_idx]
        self.n = n
        self.racked = bool(np.any(self.height > 0.01))
        # Sample points: level k (along slope) x column j (across).
        self.levels = (np.arange(SAMPLES_ALONG) + 0.5) / SAMPLES_ALONG
        cols = (np.arange(SAMPLES_ACROSS) + 0.5) / SAMPLES_ACROSS
        self.points = [  # per level: (n * SAMPLES_ACROSS, 2)
            (self.f0[:, None, :] + cols[None, :, None] * self.across[:, None, :]
             + f * self.slope[:, None, :]).reshape(-1, 2)
            for f in self.levels
        ]
        self.owner = np.repeat(np.arange(n), SAMPLES_ACROSS)

    def _obstacle_shadows(self, z: float, d: np.ndarray) -> list:
        out = []
        for poly, h in self.obstacles:
            he = h - z
            if he <= 0:
                continue
            off = d * he
            if np.hypot(*off) > MAX_SHADOW_M:
                off = off / np.hypot(*off) * MAX_SHADOW_M
            ring = np.asarray(poly.exterior.coords)
            sweeps = shapely.polygons(np.stack([ring[:-1], ring[1:], ring[1:] + off, ring[:-1] + off], axis=1))
            moved = affinity.translate(poly, *off)
            out.append(shapely.union_all(np.concatenate([[poly, moved], sweeps])).buffer(0))
        return out

    def _panel_shadows(self, f: float, d: np.ndarray):
        """Shadows of the panel parts above relative level f (all panels share the same level heights)."""
        lift = ((1 - f) * self.height)[:, None] * d[None, :]
        lo0 = self.f0 + f * self.slope
        lo1 = lo0 + self.across
        hi1 = self.f0 + self.across + self.slope + lift
        hi0 = self.f0 + self.slope + lift
        return shapely.polygons(np.stack([lo0, lo1, hi1, hi0], axis=1))

    def shaded_fraction(self, sun_az: float, sun_elev: float) -> np.ndarray:
        """Share of each panel's sample points that are in shade for light from this direction."""
        if sun_elev <= 0:
            return np.ones(self.n)
        cot = 1.0 / math.tan(math.radians(sun_elev))
        a = math.radians(sun_az)
        d = -np.array([math.sin(a), math.cos(a)]) * cot  # shadow offset per metre of height
        shaded = np.zeros(self.n)
        for k, f in enumerate(self.levels):
            geoms, owners = [], []
            # Obstacle heights are compared with each panel's own sample height.
            # Panels of one layout share the tilt, so heights differ only by panel size; use the mean.
            z = float(np.mean(f * self.height)) if self.n else 0.0
            obs = self._obstacle_shadows(z, d)
            geoms += obs
            owners += [-1] * len(obs)
            if self.racked:
                geoms += list(self._panel_shadows(f, d))
                owners += list(range(self.n))
            if not geoms:
                continue
            tree = shapely.STRtree(geoms)
            pts = shapely.points(self.points[k])
            pi, ti = tree.query(pts, predicate="within")
            owners_arr = np.asarray(owners)
            keep = owners_arr[ti] != self.owner[pi]
            hit = np.zeros(len(pts), dtype=bool)
            hit[pi[keep]] = True
            shaded += hit.reshape(self.n, SAMPLES_ACROSS).sum(axis=1)
        return shaded / (SAMPLES_ALONG * SAMPLES_ACROSS)

    def sky_blocked_fraction(self) -> np.ndarray:
        """Share of the isotropic diffuse sky light each panel loses to obstacles and other rows."""
        total = np.zeros(len(self.faces))
        blocked = np.zeros(self.n)
        # Band centre elevation -> band width (degrees); weight = cos(incidence) x solid angle.
        # Fine steps near the horizon, where obstacles block the sky; coarse steps overhead.
        bands = [(e + 2.5, 5) for e in range(0, 40, 5)] + [(45, 10), (55, 10), (67.5, 15), (82.5, 15)]
        for elev, width in bands:
            for az in range(0, 360, 10):
                u = _unit(az, elev)
                w = np.array([float(nrm @ u) * math.cos(math.radians(elev)) * width for nrm in self.normals])
                w = np.where(w > 0, w, 0.0)  # light from behind a face does not reach it
                if not w.any():
                    continue
                total += w
                if self.obstacles or self.racked:
                    blocked += w[self.face_idx] * self.shaded_fraction(az, elev)
        total = total[self.face_idx]
        return np.divide(blocked, total, out=blocked.copy(), where=total > 0)


def _faces(tilt_deg, azimuth_deg, n, faces, panel_face):
    """[(tilt, azimuth), ...] per roof face and the face index of each panel (one face if none given)."""
    if not faces:
        return [(tilt_deg, azimuth_deg)], np.zeros(n, dtype=int)
    if panel_face is None or len(panel_face) != n:
        raise ValueError("Χρειάζεται η πλευρά στέγης κάθε πάνελ.")
    idx = np.asarray(panel_face, dtype=int)
    if n and (idx.min() < 0 or idx.max() >= len(faces)):
        raise ValueError("Άκυρη πλευρά στέγης για κάποιο πάνελ.")
    return [(float(f["tilt_deg"]), float(f["azimuth_deg"])) for f in faces], idx


def _sun_table(lat, lon, tilt, azimuth):
    """Sun positions over a representative day per month, with beam and diffuse plane-of-array irradiance."""
    import pandas as pd
    import pvlib

    times = pd.DatetimeIndex([])
    for m in range(1, 13):
        day = pd.date_range(f"2023-{m:02d}-15", periods=int(24 / TIME_STEP_H), freq=f"{int(TIME_STEP_H * 60)}min", tz="UTC")
        times = times.append(day)
    loc = pvlib.location.Location(lat, lon)
    sp = loc.get_solarposition(times)
    cs = loc.get_clearsky(times, model="ineichen", solar_position=sp)
    ghi = cs["ghi"] * OFFLINE_CLOUD_FACTOR
    split = pvlib.irradiance.erbs(ghi, sp["zenith"], times)
    dni, dhi = split["dni"].fillna(0), split["dhi"].fillna(0)
    aoi = pvlib.irradiance.aoi(tilt, azimuth, sp["apparent_zenith"], sp["azimuth"])
    beam = (dni * np.cos(np.radians(aoi))).clip(lower=0)
    diffuse = dhi * (1 + math.cos(math.radians(tilt))) / 2
    ground = ghi * ALBEDO * (1 - math.cos(math.radians(tilt))) / 2
    weight = np.array([DAYS_IN_MONTH[t.month - 1] * TIME_STEP_H for t in times])  # hours represented
    return pd.DataFrame({
        "month": times.month, "elev": 90 - sp["apparent_zenith"], "az": sp["azimuth"],
        "beam": beam * weight / 1000, "diffuse": diffuse * weight / 1000, "ground": ground * weight / 1000,
    })


def analyze(panels, obstacles, tilt_deg, azimuth_deg, mounting, faces=None, panel_face=None) -> dict:
    """Annual and monthly shading loss (% of plane-of-array irradiation) and the loss of each panel.

    faces / panel_face (optional): roof faces [{"tilt_deg", "azimuth_deg"}, ...] and the face index of each
    panel; then the result also has a "faces" list with each face's own losses.
    """
    if not panels:
        raise ValueError("Δεν υπάρχουν πάνελ. Κάνε πρώτα τοποθέτηση πάνελ.")
    pts = np.array([pt for p in panels for pt in p])
    lat0, lon0 = float(pts[:, 0].mean()), float(pts[:, 1].mean())
    fwd, _ = _transformers(lat0, lon0)
    scene = Scene(panels, obstacles, tilt_deg, azimuth_deg, mounting, fwd, faces, panel_face)
    fi = scene.face_idx
    # Same sun positions for every face; only the irradiance on each face's plane differs.
    suns = [_sun_table(lat0, lon0, t, az) for t, az in scene.faces]
    sun = suns[0]
    beam = np.column_stack([s.beam.to_numpy() for s in suns])  # (times, faces)

    n = scene.n
    beam_lost = np.zeros((12, n))
    has_shaders = bool(scene.obstacles) or scene.racked
    if has_shaders:
        lit = (sun.elev > MIN_SUN_ELEVATION).to_numpy() & (beam > 0).any(axis=1)
        for i in np.flatnonzero(lit):
            beam_lost[sun.month.iat[i] - 1] += beam[i][fi] * scene.shaded_fraction(sun.az.iat[i], sun.elev.iat[i])
    sky_block = scene.sky_blocked_fraction()

    by_month = [s.groupby("month")[["beam", "diffuse", "ground"]].sum() for s in suns]
    total_f = np.column_stack([(b.beam + b.diffuse + b.ground).to_numpy() for b in by_month])  # (12, faces), kWh/m²
    diffuse_f = np.column_stack([b.diffuse.to_numpy() for b in by_month])
    lost_m = beam_lost + diffuse_f[:, fi] * sky_block[None, :]      # (12, n)
    counts = np.bincount(fi, minlength=len(scene.faces))
    total_all = sum(total_f[:, k] * counts[k] for k in range(len(scene.faces)))  # (12,), all panels
    total_year = sum(total_f[:, k].sum() * counts[k] for k in range(len(scene.faces)))

    monthly_pct = 100 * lost_m.sum(axis=1) / total_all
    annual_pct = 100 * lost_m.sum() / total_year
    panel_pct = 100 * lost_m.sum(axis=0) / total_f.sum(axis=0)[fi]
    beam_pct = 100 * beam_lost.sum() / total_year
    result = {
        "report": _report_block(scene, annual_pct, beam_pct, monthly_pct, panel_pct),
        "annual_loss_pct": round(float(annual_pct), 2),
        "beam_loss_pct": round(float(beam_pct), 2),
        "diffuse_loss_pct": round(float(annual_pct - beam_pct), 2),
        "solar_access_pct": round(100 - float(annual_pct), 2),
        "monthly_loss_pct": [round(float(v), 2) for v in monthly_pct],
        "panel_loss_pct": [round(float(v), 1) for v in panel_pct],
        "worst_panel_loss_pct": round(float(panel_pct.max()), 1),
        "obstacles_used": len(scene.obstacles),
        "row_shading": scene.racked,
    }
    if faces:
        result["faces"] = []
        for k, (t, az) in enumerate(scene.faces):
            lost_k = lost_m[:, fi == k].sum(axis=1)
            tot_k = total_f[:, k] * counts[k]
            month_k = np.divide(100 * lost_k, tot_k, out=np.zeros(12), where=tot_k > 0)
            result["faces"].append({
                "tilt_deg": t, "azimuth_deg": az, "panels": int(counts[k]),
                "annual_loss_pct": round(float(100 * lost_k.sum() / tot_k.sum()), 2) if tot_k.sum() > 0 else 0.0,
                "monthly_loss_pct": [round(float(v), 2) for v in month_k],
            })
    return result


def _fmt(v, d=1) -> str:
    return f"{v:,.{d}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _report_block(scene, annual_pct, beam_pct, monthly_pct, panel_pct) -> dict:
    """Section for the PDF report (see backend/report.py)."""
    months = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"]
    causes = []
    if scene.obstacles:
        causes.append(f"{len(scene.obstacles)} εμπόδιο(α) με ύψος")
    if scene.racked:
        causes.append("σκίαση μεταξύ σειρών πάνελ")
    summary = [
        ["Ετήσια απώλεια από σκιάσεις", f"{_fmt(annual_pct)}%"],
        ["  από άμεσο ήλιο", f"{_fmt(beam_pct)}%"],
        ["  από διάχυτο φως ουρανού", f"{_fmt(annual_pct - beam_pct)}%"],
        ["Ηλιακή πρόσβαση (solar access)", f"{_fmt(100 - annual_pct)}%"],
        ["Πιο σκιασμένο πάνελ", f"{_fmt(float(panel_pct.max()) if len(panel_pct) else 0)}%"],
        ["Αιτίες", ", ".join(causes) if causes else "καμία"],
    ]
    bins = [(0, 1, "κάτω από 1%"), (1, 5, "1–5%"), (5, 10, "5–10%"), (10, 101, "πάνω από 10%")]
    dist = [[label, str(int(((panel_pct >= lo) & (panel_pct < hi)).sum()))] for lo, hi, label in bins]
    return {
        "summary": summary,
        "tables": [
            {"title": "Απώλεια σκίασης ανά μήνα", "columns": months,
             "rows": [[f"{_fmt(v)}%" for v in monthly_pct]]},
            {"title": "Πάνελ ανά βαθμό σκίασης", "columns": ["Ετήσια απώλεια", "Πάνελ"], "rows": dist},
        ],
        "notes": [
            "Οι σκιές υπολογίζονται από τη θέση του ήλιου σε κάθε μήνα και από τα ύψη των εμποδίων που "
            "σχεδιάστηκαν. Οι απώλειες έχουν αφαιρεθεί από την παραγωγή. Η μερική σκίαση ενός πάνελ μπορεί "
            "στην πράξη να κοστίζει λίγο περισσότερο, λόγω της ηλεκτρικής συνδεσμολογίας.",
        ],
    }


def shadows_at(panels, obstacles, tilt_deg, azimuth_deg, mounting, when_utc, faces=None, panel_face=None) -> dict:
    """Shadow outlines on the panel surface (z = 0) at one moment, as [[lat, lng], ...] rings."""
    import pandas as pd
    import pvlib

    pts = np.array([pt for p in panels for pt in p] + [pt for o in obstacles for pt in o["polygon"]])
    if not len(pts):
        raise ValueError("Δεν υπάρχουν πάνελ ή εμπόδια.")
    lat0, lon0 = float(pts[:, 0].mean()), float(pts[:, 1].mean())
    fwd, inv = _transformers(lat0, lon0)
    t = pd.DatetimeIndex([pd.Timestamp(when_utc)])
    t = t.tz_localize("UTC") if t.tz is None else t.tz_convert("UTC")
    sp = pvlib.solarposition.get_solarposition(t, lat0, lon0)
    elev, az = float(90 - sp["apparent_zenith"].iloc[0]), float(sp["azimuth"].iloc[0])
    result = {"sun_elevation": round(elev, 1), "sun_azimuth": round(az, 1), "shadows": []}
    if elev <= MIN_SUN_ELEVATION:
        return result

    scene = Scene(panels, obstacles, tilt_deg, azimuth_deg, mounting, fwd, faces, panel_face)
    cot = 1.0 / math.tan(math.radians(elev))
    d = -np.array([math.sin(math.radians(az)), math.cos(math.radians(az))]) * cot
    geoms = scene._obstacle_shadows(0.0, d)
    if scene.racked:
        geoms.append(shapely.union_all(scene._panel_shadows(0.0, d)))
    shadow = shapely.union_all(geoms) if geoms else None
    if shadow is None or shadow.is_empty:
        return result
    for poly in getattr(shadow, "geoms", [shadow]):
        if poly.geom_type != "Polygon" or poly.area < 0.01:
            continue
        ring = np.asarray(poly.exterior.coords)
        lng, lat = inv.transform(ring[:, 0], ring[:, 1])
        result["shadows"].append([[float(a), float(b)] for a, b in zip(lat, lng)])
    return result
