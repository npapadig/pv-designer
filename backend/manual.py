"""Check a hand-edited panel layout against the placement rules.

The automatic layout (layout.py) keeps panels inside the roof by a set-back, away from the line between
two roof faces and from obstacles, and never on top of each other. When the user moves panels by hand
these rules can be broken; check_layout says, panel by panel, which ones. Reasons:
  outside   the panel is not (fully) inside any drawn area
  edge      inside, but closer to the outline of the area than the set-back
  ridge     closer to the line between two roof faces than the ridge gap
  obstacle  on an obstacle or closer to it than the obstacle gap
  overlap   on top of another panel
  shade     shaded more than the limit (only with check_shade and obstacles that have a height)
"""
from __future__ import annotations

from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import shading
from .layout import LayoutParams, _to_xy, _transformers, edge_cuts

REASONS = ("outside", "edge", "ridge", "obstacle", "overlap", "shade")
TOL_M = 1e-3          # 1 mm: float noise of projection and rotation is not a violation
OVERLAP_M2 = 1e-3     # touching edges are fine; a real overlap is bigger than this


def check_layout(panels: list, areas: list, p: LayoutParams, use_ridge: bool = False,
                 obstacles: list | None = None, check_shade: bool = False, max_shade_pct: float = 10.0,
                 tilt_deg: float = 30.0, azimuth_deg: float = 180.0, mounting: str = "flush",
                 faces: list | None = None, panel_face: list | None = None) -> dict:
    """panels: [[[lat, lng] x4], ...]; areas: outlines [[lat, lng], ...] (roof faces when use_ridge: then
    the edges they share are kept clear by p.ridge_gap_m); p.keepouts: the obstacle outlines.

    Returns {"count_bad", "by_reason", "violations": [{"index", "reasons"}], "area_of": [area index of every
    panel or -1 when it is in none]}.
    """
    if not panels:
        return {"count_bad": 0, "by_reason": {}, "violations": [], "area_of": []}
    if not areas:
        raise ValueError("Σχεδίασε πρώτα μια περιοχή στον χάρτη.")
    pts = [pt for a in areas for pt in a]
    lat0 = sum(pt[0] for pt in pts) / len(pts)
    lon0 = sum(pt[1] for pt in pts) / len(pts)
    fwd, _ = _transformers(lat0, lon0)

    shapes = [_to_xy(pn, fwd) for pn in panels]
    outlines = [_to_xy(a, fwd) for a in areas]
    gap = p.setback_m if p.obstacle_gap_m is None else p.obstacle_gap_m
    zone = unary_union([_to_xy(k, fwd).buffer(gap, join_style="mitre") for k in p.keepouts if len(k) >= 3]) \
        if p.keepouts else None

    # Per area: the strips that must stay clear (free edges: set-back; shared edges: ridge gap).
    strips = []
    ridge_on = use_ridge and p.ridge_gap_m is not None and p.ridge_gap_m != p.setback_m
    for i, a in enumerate(outlines):
        if ridge_on:
            others = [o for j, o in enumerate(outlines) if j != i]
            strips.append(edge_cuts(a, others, p))
        else:
            strips.append((a.difference(a.buffer(-p.setback_m, join_style="mitre")), Polygon()))

    area_of, reasons = [], [[] for _ in shapes]
    for k, s in enumerate(shapes):
        inter = [s.intersection(a).area for a in outlines]
        best = max(range(len(outlines)), key=lambda i: inter[i])
        if inter[best] <= 0:
            area_of.append(-1)
            reasons[k].append("outside")
            continue
        area_of.append(best)
        if not outlines[best].buffer(TOL_M).contains(s):
            reasons[k].append("outside")
            continue
        edge, ridge = strips[best]
        if s.intersection(edge).area > OVERLAP_M2 * 0.1:
            reasons[k].append("edge")
        if not ridge.is_empty and s.intersection(ridge).area > OVERLAP_M2 * 0.1:
            reasons[k].append("ridge")

    if zone is not None and not zone.is_empty:
        for k, s in enumerate(shapes):
            if s.intersection(zone).area > OVERLAP_M2 * 0.1:
                reasons[k].append("obstacle")

    tree = STRtree(shapes)
    for k, s in enumerate(shapes):
        for j in tree.query(s):
            if j > k and s.intersection(shapes[j]).area > OVERLAP_M2:
                for m in (k, int(j)):
                    if "overlap" not in reasons[m]:
                        reasons[m].append("overlap")

    if check_shade and obstacles and any(o.get("height_m", 0) > 0 for o in obstacles):
        analysis = shading.analyze(panels, obstacles, tilt_deg, azimuth_deg, mounting, faces, panel_face)
        for k, pct in enumerate(analysis["panel_loss_pct"]):
            if pct > max_shade_pct:
                reasons[k].append("shade")

    violations = [{"index": k, "reasons": r} for k, r in enumerate(reasons) if r]
    by_reason = {c: n for c in REASONS if (n := sum(c in v["reasons"] for v in violations))}
    return {"count_bad": len(violations), "by_reason": by_reason, "violations": violations, "area_of": area_of}
