"""Placement options: separate gaps (outline / ridge / obstacles) and tables with walkways (stream topothetisi)."""
from backend.layout import LayoutParams, compute_faces_layout, compute_layout
from tests.test_layout import square
from tests.test_shading import rect

BASE = dict(panel_width_m=1.0, panel_length_m=2.0, tilt_deg=0, col_spacing_m=0, row_spacing_m=0, setback_m=0, mounting="rack")


def test_defaults_change_nothing():
    a = compute_layout(square(10.01, 10.01), LayoutParams(**BASE))
    b = compute_layout(square(10.01, 10.01), LayoutParams(**BASE, ridge_gap_m=None, obstacle_gap_m=None, table_panels=0))
    assert a["panels"] == b["panels"]


def test_obstacle_gap_is_separate_from_the_outline_gap():
    ko = [square(2, 2)]
    near = compute_layout(square(10.01, 10.01), LayoutParams(**BASE, keepouts=ko))["count"]
    far = compute_layout(square(10.01, 10.01), LayoutParams(**BASE, keepouts=ko, obstacle_gap_m=1.5))["count"]
    same = compute_layout(square(10.01, 10.01), LayoutParams(**BASE, keepouts=ko, obstacle_gap_m=0))["count"]
    assert far < near == same
    # the outline gap does not change when only the obstacle gap does
    edge = compute_layout(square(10.01, 10.01), LayoutParams(**{**BASE, "setback_m": 1}, obstacle_gap_m=0, keepouts=ko))
    full = compute_layout(square(10.01, 10.01), LayoutParams(**{**BASE, "setback_m": 1}, keepouts=ko))
    assert edge["count"] > full["count"]


def test_tables_leave_a_walkway_every_n_panels():
    p0 = LayoutParams(**BASE)
    flat = compute_layout(square(12.01, 2.01), p0)
    tabled = compute_layout(square(12.01, 2.01), LayoutParams(**BASE, table_panels=4, table_gap_m=0.8))
    assert flat["count"] == 12
    assert tabled["count"] == 10  # 4 + 0.8 + 4 + 0.8 + 2 panels (the third would end at 12.6 m)
    xs = sorted({round(c[1], 7) for pn in tabled["panels"] for c in pn})
    assert len(xs) > 1


def test_tables_do_not_change_the_row_gap():
    a = compute_layout(square(12.01, 6.01), LayoutParams(**BASE))
    b = compute_layout(square(12.01, 6.01), LayoutParams(**BASE, table_panels=3, table_gap_m=0.5))
    assert a["row_gap_m"] == b["row_gap_m"]


def test_ridge_gap_applies_only_to_the_line_between_faces():
    south, north = rect(-5, -4, 5, 0), rect(-5, 0, 5, 4)
    faces = [{"area": south, "tilt_deg": 0, "azimuth_deg": 180}, {"area": north, "tilt_deg": 0, "azimuth_deg": 180}]
    p = dict(BASE, setback_m=0.5)
    default = compute_faces_layout(faces, LayoutParams(**p))["count"]
    same = compute_faces_layout(faces, LayoutParams(**p, ridge_gap_m=0.5))["count"]
    tight = compute_faces_layout(faces, LayoutParams(**p, ridge_gap_m=0.0))["count"]
    wide = compute_faces_layout(faces, LayoutParams(**p, ridge_gap_m=2.0))["count"]
    assert default == same
    assert wide < default <= tight
