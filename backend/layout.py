"""Panel layout: fill a drawn area (lat/lng polygon) with a grid of PV modules.

Coordinates are projected to a local metric plane (azimuthal equidistant
centred on the area), rotated so the modules face "south" in that frame,
filled row by row, then rotated and projected back to lat/lng.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

from pyproj import Transformer
from shapely import affinity
from shapely.geometry import LineString, Polygon, box
from shapely.ops import split, unary_union

# Sun elevation at solar noon on the winter solstice is 90 - lat - 23.44.
WINTER_SOLSTICE_DECLINATION = 23.44

# The three ready-made layout proposals (layout_options), as decided by Νίκος on 2026-10-22.
# The tilt is not fixed: every whole degree from tilt_deg down to tilt_min_deg is tried and the one that fits
# the most panels wins (a tie keeps the tilt closer to tilt_deg). row_gap_m None = automatic (no shade at
# winter-solstice noon).
OPTION_ECONOMIC = {"tilt_deg": 30.0, "tilt_min_deg": 20.0, "azimuth_deg": 180.0, "row_gap_m": None}  # south
OPTION_EAST_WEST = {"tilt_deg": 10.0, "tilt_min_deg": 8.0, "row_gap_m": 0.10}  # back to back, rows almost touching
OPTION_AESTHETIC = {"tilt_deg": 15.0, "tilt_min_deg": 10.0, "row_gap_m": None}  # parallel to the longest wall


@dataclass
class LayoutParams:
    panel_width_m: float = 1.134       # short side
    panel_length_m: float = 1.722      # long side
    panel_power_w: float = 410.0
    orientation: str = "portrait"      # "portrait" | "landscape"
    azimuth_deg: float = 180.0         # compass: 0=N, 90=E, 180=S, 270=W
    tilt_deg: float = 30.0
    mounting: str = "flush"            # "flush" (on pitched roof) | "rack" (flat roof / ground)
    row_spacing_m: float | None = None  # gap between rows; None = automatic
    col_spacing_m: float = 0.02        # gap between modules in a row
    setback_m: float = 0.5             # keep-away distance from the area edge
    keepouts: list = field(default_factory=list)  # list of [[lat, lng], ...]


def _transformers(lat0: float, lon0: float):
    proj = f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +datum=WGS84 +units=m"
    fwd = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
    inv = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    return fwd, inv


def _to_xy(latlngs, fwd) -> Polygon:
    pts = [fwd.transform(lng, lat) for lat, lng in latlngs]
    return Polygon(pts).buffer(0)


def auto_row_gap(along_slope_m: float, tilt_deg: float, lat_deg: float) -> float:
    """Gap between rack rows so a row does not shade the next at winter-solstice noon."""
    elev = 90.0 - abs(lat_deg) - WINTER_SOLSTICE_DECLINATION
    elev = max(elev, 10.0)  # avoid absurd gaps at high latitudes
    height = along_slope_m * math.sin(math.radians(tilt_deg))
    return height / math.tan(math.radians(elev))


def compute_layout(area_latlngs: list, p: LayoutParams) -> dict:
    if len(area_latlngs) < 3:
        raise ValueError("Η περιοχή χρειάζεται τουλάχιστον 3 σημεία.")

    lat0 = sum(pt[0] for pt in area_latlngs) / len(area_latlngs)
    lon0 = sum(pt[1] for pt in area_latlngs) / len(area_latlngs)
    fwd, inv = _transformers(lat0, lon0)

    area = _to_xy(area_latlngs, fwd)
    usable = area.buffer(-p.setback_m, join_style="mitre")
    if p.keepouts:
        obstacles = unary_union([
            _to_xy(k, fwd).buffer(p.setback_m, join_style="mitre")
            for k in p.keepouts if len(k) >= 3
        ])
        usable = usable.difference(obstacles)

    # Rotate so modules face -y. Shapely rotates counter-clockwise, which lowers
    # the compass bearing, so rotating by (azimuth - 180) brings it to 180.
    angle = p.azimuth_deg - 180.0
    rot = affinity.rotate(usable, angle, origin=(0, 0))

    if p.orientation == "landscape":
        across, along_slope = p.panel_length_m, p.panel_width_m
    else:
        across, along_slope = p.panel_width_m, p.panel_length_m
    depth = along_slope * math.cos(math.radians(p.tilt_deg))

    if p.row_spacing_m is not None:
        row_gap = p.row_spacing_m
    elif p.mounting == "rack":
        row_gap = auto_row_gap(along_slope, p.tilt_deg, lat0)
    else:
        row_gap = p.col_spacing_m

    panels_xy = []
    if not rot.is_empty:
        minx, miny, maxx, maxy = rot.bounds
        fit = rot.buffer(1e-6)  # tolerate floating-point noise from projection and rotation
        step_x = across + p.col_spacing_m
        step_y = depth + row_gap
        y = maxy - depth  # start at the back (north side in the rotated frame)
        while y >= miny - 1e-9:
            x = minx
            while x + across <= maxx + 1e-9:
                cell = box(x, y, x + across, y + depth)
                if fit.contains(cell):
                    panels_xy.append(cell)
                    x += step_x
                else:
                    x += step_x / 4  # slide in smaller steps to pack edges tighter
            y -= step_y

    panels = []
    for cell in panels_xy:
        back = affinity.rotate(cell, -angle, origin=(0, 0))
        coords = [inv.transform(x, y) for x, y in list(back.exterior.coords)[:-1]]
        panels.append([[lat, lng] for lng, lat in coords])

    count = len(panels)
    return {
        "panels": panels,
        "count": count,
        "kwp": round(count * p.panel_power_w / 1000.0, 3),
        "area_m2": round(area.area, 1),
        "usable_area_m2": round(usable.area, 1) if not usable.is_empty else 0.0,
        "module_area_m2": round(count * p.panel_width_m * p.panel_length_m, 1),
        "row_gap_m": round(row_gap, 2),
        "center": [lat0, lon0],
    }


def compute_faces_layout(faces: list, p: LayoutParams) -> dict:
    """Layout of several roof faces, each with its own tilt and azimuth (None = the common value in p).

    faces: [{"area": [[lat, lng], ...], "tilt_deg": float | None, "azimuth_deg": float | None}, ...].
    Returns the totals, all panels in one list with the face index of each panel, and one entry per face.
    """
    if not faces:
        raise ValueError("Δεν υπάρχει καμία πλευρά στέγης.")
    panels, panel_face, per_face = [], [], []
    for i, f in enumerate(faces):
        tilt = p.tilt_deg if f.get("tilt_deg") is None else f["tilt_deg"]
        azimuth = p.azimuth_deg if f.get("azimuth_deg") is None else f["azimuth_deg"]
        res = compute_layout(f["area"], replace(p, tilt_deg=tilt, azimuth_deg=azimuth))
        panels += res["panels"]
        panel_face += [i] * res["count"]
        per_face.append({"tilt_deg": tilt, "azimuth_deg": azimuth,
                         **{k: v for k, v in res.items() if k != "panels"}})
    count = len(panels)
    return {
        "panels": panels,
        "panel_face": panel_face,
        "faces": per_face,
        "count": count,
        "kwp": round(count * p.panel_power_w / 1000.0, 3),
        "area_m2": round(sum(f["area_m2"] for f in per_face), 1),
        "usable_area_m2": round(sum(f["usable_area_m2"] for f in per_face), 1),
        "module_area_m2": round(count * p.panel_width_m * p.panel_length_m, 1),
        "row_gap_m": per_face[-1]["row_gap_m"],
        "center": per_face[0]["center"],
    }


def _bearing(dx: float, dy: float) -> float:
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def split_area(area_latlngs: list, line_latlngs: list, extend_m: float = 1.5) -> list:
    """Cut a drawn roof into faces along a line (e.g. the ridge).

    The two end segments are lengthened by extend_m so a line that stops just short of the edge
    still cuts through. Returns [{"area": [[lat, lng], ...], "azimuth_deg": suggestion}, ...]; the
    suggested azimuth points away from the cut line, the way a roof face slopes down from its ridge.
    One piece means the line did not cut the area.
    """
    if len(area_latlngs) < 3:
        raise ValueError("Η περιοχή χρειάζεται τουλάχιστον 3 σημεία.")
    if len(line_latlngs) < 2:
        raise ValueError("Η γραμμή χρειάζεται τουλάχιστον 2 σημεία.")
    lat0 = sum(pt[0] for pt in area_latlngs) / len(area_latlngs)
    lon0 = sum(pt[1] for pt in area_latlngs) / len(area_latlngs)
    fwd, inv = _transformers(lat0, lon0)
    area = _to_xy(area_latlngs, fwd)
    pts = [fwd.transform(lng, lat) for lat, lng in line_latlngs]

    def lengthen(a, b):  # move b further away from a
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy)
        return (b[0] + dx / d * extend_m, b[1] + dy / d * extend_m) if d > 1e-9 else b

    pts[0] = lengthen(pts[1], pts[0])
    pts[-1] = lengthen(pts[-2], pts[-1])
    line = LineString(pts)
    pieces = [g for g in split(area, line).geoms if g.geom_type == "Polygon" and g.area >= 0.05]
    if len(pieces) < 2:
        return [{"area": [list(pt) for pt in area_latlngs], "azimuth_deg": None}]

    out = []
    for piece in pieces:
        # The segment of the cut line that borders this piece the most gives the face direction.
        edge = piece.exterior.buffer(0.01)
        segs = [LineString(pts[i:i + 2]) for i in range(len(pts) - 1)]
        seg = max(segs, key=lambda sg: sg.intersection(edge).length)
        (ax, ay), (bx, by) = seg.coords
        nx, ny = by - ay, -(bx - ax)  # perpendicular to the segment
        c = piece.representative_point()
        if (c.x - ax) * nx + (c.y - ay) * ny < 0:
            nx, ny = -nx, -ny
        coords = [inv.transform(x, y) for x, y in list(piece.exterior.coords)[:-1]]
        out.append({"area": [[lat, lng] for lng, lat in coords], "azimuth_deg": round(_bearing(nx, ny))})
    return out


# ---------------------------------------------------------------- ready-made proposals
def _ang_diff(a: float, b: float) -> float:
    return abs((a - b + 540.0) % 360.0 - 180.0)


def wall_azimuth(area_latlngs: list) -> int:
    """Azimuth facing away from the longest edge (the wall), on the side that looks more to the south."""
    if len(area_latlngs) < 3:
        raise ValueError("Η περιοχή χρειάζεται τουλάχιστον 3 σημεία.")
    lat0 = sum(pt[0] for pt in area_latlngs) / len(area_latlngs)
    lon0 = sum(pt[1] for pt in area_latlngs) / len(area_latlngs)
    fwd, _ = _transformers(lat0, lon0)
    pts = [fwd.transform(lng, lat) for lat, lng in area_latlngs]
    a, b = max(((pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))),
               key=lambda e: math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))
    bearing = _bearing(b[0] - a[0], b[1] - a[1])
    az = min(((bearing + 90.0) % 360.0, (bearing + 270.0) % 360.0), key=lambda x: _ang_diff(x, 180.0))
    return round(az) % 360


def compute_ew_layout(area_latlngs: list, p: LayoutParams, row_gap_m: float) -> dict:
    """East-west racks "back to back": rows run north-south and face east and west in turn.

    The grid is the one of compute_layout facing east; every second row is then turned to the west,
    so each pair of rows meets at its high edge. The result has the shape of compute_faces_layout
    with two faces: 0 = east (90°), 1 = west (270°).
    """
    q = replace(p, azimuth_deg=90.0, mounting="rack", row_spacing_m=row_gap_m)
    res = compute_layout(area_latlngs, q)
    along_slope = q.panel_width_m if q.orientation == "landscape" else q.panel_length_m
    step = along_slope * math.cos(math.radians(q.tilt_deg)) + row_gap_m
    fwd, _ = _transformers(*res["center"])
    ys = []
    for panel in res["panels"]:
        c = Polygon([fwd.transform(lng, lat) for lat, lng in panel]).centroid
        ys.append(affinity.rotate(c, q.azimuth_deg - 180.0, origin=(0, 0)).y)
    top = max(ys, default=0.0)
    # Row 0 is the westernmost (the back of an east-facing grid); it leans against row 1, so it faces west.
    panel_face = [1 - round((top - y) / step) % 2 for y in ys]
    per_face = []
    for k, az in ((0, 90.0), (1, 270.0)):
        n = panel_face.count(k)
        per_face.append({"tilt_deg": q.tilt_deg, "azimuth_deg": az, "count": n,
                         "kwp": round(n * q.panel_power_w / 1000.0, 3), "row_gap_m": res["row_gap_m"]})
    return {**res, "panel_face": panel_face, "faces": per_face}


def _merge(results: list[dict], p: LayoutParams) -> dict:
    """Totals of several drawn areas laid out with the same settings (faces are added up by index)."""
    out = {
        "panels": [pn for r in results for pn in r["panels"]],
        "area_m2": round(sum(r["area_m2"] for r in results), 1),
        "usable_area_m2": round(sum(r["usable_area_m2"] for r in results), 1),
        "row_gap_m": results[-1]["row_gap_m"],
        "center": results[0]["center"],
    }
    out["count"] = len(out["panels"])
    out["kwp"] = round(out["count"] * p.panel_power_w / 1000.0, 3)
    out["module_area_m2"] = round(out["count"] * p.panel_width_m * p.panel_length_m, 1)
    if results[0].get("faces"):
        out["panel_face"] = [k for r in results for k in r["panel_face"]]
        out["faces"] = [{**f, "count": out["panel_face"].count(k),
                         "kwp": round(out["panel_face"].count(k) * p.panel_power_w / 1000.0, 3)}
                        for k, f in enumerate(results[0]["faces"])]
    return out


def compute_ew_areas(areas: list, p: LayoutParams) -> dict:
    """East-west layout of all drawn areas; the row gap is p.row_spacing_m, or the proposal's when None."""
    if not areas:
        raise ValueError("Σχεδίασε πρώτα μια περιοχή στον χάρτη.")
    gap = OPTION_EAST_WEST["row_gap_m"] if p.row_spacing_m is None else p.row_spacing_m
    q = replace(p, mounting="rack", row_spacing_m=gap)
    return _merge([compute_ew_layout(a, q, gap) for a in areas], q)


def best_tilt(layout_at, tilt_deg: float, tilt_min_deg: float) -> tuple[float, dict]:
    """Try every whole degree from tilt_deg down to tilt_min_deg; keep the layout with the most panels.

    layout_at(tilt) returns a layout dict. On a tie the tilt closer to tilt_deg (the nominal one) is kept.
    """
    best = None
    tilt = tilt_deg
    while tilt >= tilt_min_deg - 1e-9:
        res = layout_at(tilt)
        if best is None or res["count"] > best[1]["count"]:
            best = (tilt, res)
        tilt -= 1.0
    return best


def layout_options(areas: list, p: LayoutParams, east_west: bool = False) -> list[dict]:
    """The ready-made proposals for the same drawn areas (panel size, setbacks, gaps from p), then "manual".

    Each one: key, title, the settings it uses (tilt, azimuth, mounting, row_spacing_m: None = automatic)
    and the merged layout of all areas. The east-west one also has panel_face and two faces. The manual one
    uses p as it is (east-west racks when east_west is set).
    """
    if not areas:
        raise ValueError("Σχεδίασε πρώτα μια περιοχή στον χάρτη.")
    wall = float(wall_azimuth(areas[0]))
    plans = [
        ("economic", "Οικονομική", "Νότια, βέλτιστη απόδοση για το κόστος", OPTION_ECONOMIC,
         OPTION_ECONOMIC["azimuth_deg"]),
        ("east_west", "Μέγιστη ενέργεια", "Ανατολή-δύση πλάτη με πλάτη, τα περισσότερα πάνελ", OPTION_EAST_WEST, 90.0),
        ("aesthetic", "Αισθητική", "Παράλληλα με τον τοίχο του κτιρίου", OPTION_AESTHETIC, wall),
    ]
    out = []
    for key, title, note, opt, az in plans:
        gap = opt["row_gap_m"]

        def layout_at(tilt, key=key, az=az, gap=gap):
            q = replace(p, tilt_deg=tilt, azimuth_deg=az, mounting="rack", row_spacing_m=gap)
            if key == "east_west":
                return _merge([compute_ew_layout(a, q, gap) for a in areas], q)
            return _merge([compute_layout(a, q) for a in areas], q)

        tilt, res = best_tilt(layout_at, opt["tilt_deg"], opt["tilt_min_deg"])
        out.append({"key": key, "title": title, "note": note, "tilt_deg": tilt, "azimuth_deg": az,
                    "mounting": "rack", "row_spacing_m": gap, **res})
    ew = east_west and p.mounting == "rack"
    manual = compute_ew_areas(areas, p) if ew else _merge([compute_layout(a, p) for a in areas], p)
    out.append({"key": "manual", "title": "Χειροκίνητα", "note": "Οι ρυθμίσεις του βήματος «Πάνελ» όπως είναι",
                "tilt_deg": p.tilt_deg, "azimuth_deg": 90.0 if ew else p.azimuth_deg, "mounting": p.mounting,
                "row_spacing_m": p.row_spacing_m, "east_west": ew, **manual})
    return out
