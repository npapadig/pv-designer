import math

from pyproj import Transformer

from backend.layout import LayoutParams, auto_row_gap, compute_layout

LAT0, LON0 = 37.98, 23.72


def square(w, h, lat0=LAT0, lon0=LON0):
    """Axis-aligned rectangle of w x h metres (east x north) as [[lat, lng], ...]."""
    proj = f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +datum=WGS84 +units=m"
    inv = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return [[lat, lng] for lng, lat in (inv.transform(x, y) for x, y in pts)]


def test_flat_flush_grid_count():
    # 10 x 10 m, no setback, flat panels 1 x 2 m portrait, no gaps -> 10 x 5 = 50
    p = LayoutParams(panel_width_m=1.0, panel_length_m=2.0, panel_power_w=500, tilt_deg=0,
                     col_spacing_m=0, setback_m=0, row_spacing_m=0)
    res = compute_layout(square(10.01, 10.01), p)
    assert res["count"] == 50
    assert res["kwp"] == 25.0
    assert abs(res["area_m2"] - 100.2) < 0.5


def test_setback_reduces_count():
    base = dict(panel_width_m=1.0, panel_length_m=2.0, tilt_deg=0, col_spacing_m=0, row_spacing_m=0)
    a = compute_layout(square(10.01, 10.01), LayoutParams(setback_m=0, **base))["count"]
    b = compute_layout(square(10.01, 10.01), LayoutParams(setback_m=1, **base))["count"]
    assert b < a
    assert b == 8 * 4


def test_keepout_removes_panels():
    base = LayoutParams(panel_width_m=1.0, panel_length_m=2.0, tilt_deg=0, col_spacing_m=0,
                        row_spacing_m=0, setback_m=0)
    full = compute_layout(square(10.01, 10.01), base)["count"]
    base.keepouts = [square(2, 2)]
    assert compute_layout(square(10.01, 10.01), base)["count"] < full


def test_azimuth_rotation_keeps_count_for_square():
    base = dict(panel_width_m=1.0, panel_length_m=2.0, tilt_deg=0, col_spacing_m=0,
                row_spacing_m=0, setback_m=0)
    south = compute_layout(square(10.01, 10.01), LayoutParams(azimuth_deg=180, **base))["count"]
    east = compute_layout(square(10.01, 10.01), LayoutParams(azimuth_deg=90, **base))["count"]
    assert south == east == 50


def test_panels_inside_area():
    res = compute_layout(square(20, 12), LayoutParams(azimuth_deg=200, tilt_deg=25))
    lats = [pt[0] for pt in square(20, 12)]
    for panel in res["panels"]:
        assert len(panel) == 4
        for lat, _ in panel:
            assert min(lats) - 1e-9 <= lat <= max(lats) + 1e-9


def test_auto_row_gap_athens():
    # 2 m module at 30° in Athens: height 1 m, winter noon sun ~28.6° -> gap ~1.83 m
    gap = auto_row_gap(2.0, 30, 37.98)
    assert math.isclose(gap, 1.0 / math.tan(math.radians(90 - 37.98 - 23.44)), rel_tol=1e-6)
    assert 1.7 < gap < 2.0


def test_too_few_points():
    import pytest
    with pytest.raises(ValueError):
        compute_layout([[0, 0], [0, 1]], LayoutParams())
