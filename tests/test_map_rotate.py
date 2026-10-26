"""Map rotation (view only): the vendored leaflet-rotate is loaded after Leaflet and before Leaflet.draw."""
from pathlib import Path

FRONT = Path(__file__).resolve().parent.parent / "frontend"


def test_rotate_library_present_and_ordered():
    assert (FRONT / "vendor" / "leaflet-rotate" / "leaflet-rotate-src.js").is_file()
    assert (FRONT / "vendor" / "leaflet-rotate" / "LICENSE").is_file()
    html = (FRONT / "index.html").read_text(encoding="utf-8")
    a = html.index("vendor/leaflet/leaflet.js")
    b = html.index("vendor/leaflet-rotate/leaflet-rotate-src.js")
    c = html.index("vendor/leaflet-draw/leaflet.draw.js")
    assert a < b < c


def test_rotation_not_saved_in_project():
    app = (FRONT / "app.js").read_text(encoding="utf-8")
    assert "rotate: true" in app
    assert "getBearing" not in app
