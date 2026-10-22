"""Static map picture of a project's layout, for the PDF report.

Downloads tiles of the same base map the user sees in the app (Esri, Esri Clarity,
Google, Cadastre orthophotos or OpenStreetMap) around the drawn areas, at the
sharpest zoom that source has there, stitches them and draws the areas, keep-outs
and panels on top, plus a north arrow and a scale bar.
Without internet the shapes are drawn on a plain background instead.
"""
from __future__ import annotations

import io
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

TILE = 256
DEFAULT_NATIVE_ZOOM = 19
FONT_PATH = Path(__file__).resolve().parent / "fonts" / "DejaVuSans.ttf"
GOOGLE_TILES = "https://tile.googleapis.com"
KTIMA_WMS = "http://gis.ktimanet.gr/wms/wmsopen/wmsserver.aspx"

MARGIN = 1.4  # frame = drawn shapes x this, so a little of the surroundings shows
MIN_GROUND_M = 35.0  # never zoom in closer than this picture width (a small roof keeps some context)
MAX_SOURCE_PX = 2.0  # download at most this many source pixels per picture pixel

AREA_COLOR = (245, 158, 11)
KEEPOUT_COLOR = (239, 68, 68)
PANEL_FILL = (37, 99, 235, 210)
PANEL_EDGE = (219, 234, 254, 255)


@dataclass
class Source:
    """A base map: tile URL ({z}/{x}/{y}), its credit line and how sharp it gets."""
    key: str
    url: str
    attribution: str
    max_zoom: int = DEFAULT_NATIVE_ZOOM
    tilemap: str | None = None  # Esri: tells which zoom levels have real imagery
    params: dict = field(default_factory=dict)


ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
CLARITY = "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer"
SOURCES = {
    "esri": Source("esri", ESRI + "/tile/{z}/{y}/{x}", "Εικόνα: Esri, Maxar", tilemap=ESRI + "/tilemap"),
    "clarity": Source("clarity", CLARITY + "/tile/{z}/{y}/{x}", "Εικόνα: Esri Clarity, Maxar",
                      tilemap=CLARITY + "/tilemap"),
    "streets": Source("streets", "https://tile.openstreetmap.org/{z}/{x}/{y}.png", "© OpenStreetMap"),
    "ktimatologio": Source("ktimatologio", "wms", "Ορθοφωτογραφίες © Ελληνικό Κτηματολόγιο", max_zoom=20),
}


def _world_px(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = TILE * 2 ** z
    lat_r = math.radians(max(min(lat, 85.0), -85.0))
    x = (lon + 180.0) / 360.0 * n
    y = (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n
    return x, y


def _lonlat(x: float, y: float, z: int) -> tuple[float, float]:
    n = TILE * 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def _tile_request(src: Source, z: int, x: int, y: int) -> tuple[str, dict]:
    if src.url == "wms":
        # The Cadastre serves a WMS in degrees; one small request per map tile matches
        # the tile grid (the curvature inside one tile is far below a pixel).
        w, n = _lonlat(x * TILE, y * TILE, z)
        e, s = _lonlat((x + 1) * TILE, (y + 1) * TILE, z)
        return KTIMA_WMS, {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "LAYERS": "KTBASEMAP",
                           "STYLES": "", "FORMAT": "image/jpeg", "SRS": "EPSG:4326",
                           "BBOX": f"{w},{s},{e},{n}", "WIDTH": TILE, "HEIGHT": TILE}
    return src.url.format(z=z, x=x, y=y), src.params


def _fetch_tile(client: httpx.Client, src: Source, z: int, x: int, y: int) -> Image.Image | None:
    try:
        url, params = _tile_request(src, z, x, y)
        r = client.get(url, params=params)
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def _native_zoom(client: httpx.Client, src: Source, lat: float, lon: float) -> int:
    """Highest zoom with real imagery here (above it the picture would only be stretched)."""
    if not src.tilemap:
        return src.max_zoom
    for z in range(22, 15, -1):
        x, y = (int(v // TILE) for v in _world_px(lat, lon, z))
        try:
            d = client.get(f"{src.tilemap}/{z}/{y}/{x}/1/1", params={"f": "json"}).json()
        except Exception:
            return DEFAULT_NATIVE_ZOOM
        if d.get("data") and d["data"][0] == 1:
            return z
    return 16


def google_source(client: httpx.Client, key: str, lat: float, lon: float) -> Source | None:
    """Google satellite tiles through the owner's own Map Tiles API key; None if the key does not work."""
    try:
        r = client.post(f"{GOOGLE_TILES}/v1/createSession", params={"key": key},
                        json={"mapType": "satellite", "language": "el-GR", "region": "GR"})
        r.raise_for_status()
        session = r.json()["session"]
    except Exception:
        return None
    params = {"session": session, "key": key}
    best, credit = 20, ""
    try:
        d = client.get(f"{GOOGLE_TILES}/tile/v1/viewport", params={
            **params, "zoom": 20, "north": lat + 1e-4, "south": lat - 1e-4,
            "east": lon + 1e-4, "west": lon - 1e-4}).json()
        zooms = [r["maxZoom"] for r in d.get("maxZoomRects", [])
                 if r["south"] <= lat <= r["north"] and r["west"] <= lon <= r["east"]]
        best = max(zooms, default=best)
        credit = d.get("copyright") or ""
    except Exception:
        pass  # optional: tiles work without it
    return Source("google", f"{GOOGLE_TILES}/v1/2dtiles/{{z}}/{{x}}/{{y}}",
                  "Google" + (f" · {credit}" if credit else ""), max_zoom=min(best, 22), params=params)


def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except OSError:
        return ImageFont.load_default()


def frame(lats, lons, lat_c: float, width: int, height: int, z: int, max_px: float):
    """Crop around the shapes (plus a margin, at least MIN_GROUND_M wide) with the picture's aspect.

    Returns (zoom, left, top, crop_w, crop_h) in world pixels of that zoom. The zoom is the
    given one, lowered while the crop would need more than max_px source pixels."""
    while True:
        x0, y0 = _world_px(max(lats), min(lons), z)
        x1, y1 = _world_px(min(lats), max(lons), z)
        m_per_px = 156543.03392 * math.cos(math.radians(lat_c)) / 2 ** z
        crop_w = max((x1 - x0) * MARGIN, (y1 - y0) * MARGIN * width / height, MIN_GROUND_M / m_per_px)
        if crop_w <= max_px or z <= 3:
            break
        z -= 1
    crop_h = crop_w * height / width
    return z, (x0 + x1 - crop_w) / 2, (y0 + y1 - crop_h) / 2, crop_w, crop_h


def render_layout(
    areas: list, keepouts: list, panels: list,
    width: int = 1600, height: int = 1000, imagery: bool = True,
    basemap: str = "esri", google_key: str = "",
) -> tuple[bytes, bool]:
    """Return (JPEG bytes, whether a base map picture is shown).

    basemap: the map the user has on screen ("esri", "clarity", "google", "ktimatologio",
    "streets"); Google needs google_key, and falls back to Esri when it does not work.
    """
    pts = [p for poly in (areas or panels) for p in poly]
    if not pts:
        raise ValueError("Δεν υπάρχει σχεδιασμένη περιοχή.")
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    lat_c = (min(lats) + max(lats)) / 2
    lon_c = (min(lons) + max(lons)) / 2

    has_imagery = False
    src = None
    if imagery:
        with httpx.Client(timeout=10.0, follow_redirects=True, headers={"User-Agent": "pv-designer"}) as client:
            if basemap == "google" and google_key:
                src = google_source(client, google_key, lat_c, lon_c)
            src = src or SOURCES.get(basemap) or SOURCES["esri"]
            z, left, top, crop_w, crop_h = frame(lats, lons, lat_c, width, height,
                                                 _native_zoom(client, src, lat_c, lon_c), width * MAX_SOURCE_PX)
            tx0, ty0 = int(left // TILE), int(top // TILE)
            tx1, ty1 = int((left + crop_w) // TILE), int((top + crop_h) // TILE)
            coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
            with ThreadPoolExecutor(8) as pool:
                tiles = list(pool.map(lambda c: _fetch_tile(client, src, z, *c), coords))
        if sum(t is not None for t in tiles) >= len(tiles) / 2:
            has_imagery = True
            mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE), (200, 200, 200))
            for (tx, ty), t in zip(coords, tiles):
                if t is not None:
                    mosaic.paste(t.resize((TILE, TILE)) if t.size != (TILE, TILE) else t,
                                 ((tx - tx0) * TILE, (ty - ty0) * TILE))
            ox, oy = left - tx0 * TILE, top - ty0 * TILE
            base = mosaic.resize((width, height), Image.LANCZOS, box=(ox, oy, ox + crop_w, oy + crop_h))
    if not has_imagery:
        # No picture to keep sharp, so fill the frame with the shapes.
        z, left, top, crop_w, crop_h = frame(lats, lons, lat_c, width, height, 22, width)
        base = Image.new("RGB", (width, height), (238, 241, 245))
    scale = width / crop_w

    def to_px(poly):
        out = []
        for lat, lon in poly:
            x, y = _world_px(lat, lon, z)
            out.append(((x - left) * scale, (y - top) * scale))
        return out

    img = base.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    line = max(2, width // 500)
    for poly in areas:
        d.polygon(to_px(poly), fill=AREA_COLOR + (25,), outline=AREA_COLOR + (255,), width=line)
    for poly in keepouts:
        d.polygon(to_px(poly), fill=KEEPOUT_COLOR + (90,), outline=KEEPOUT_COLOR + (255,), width=line)
    for poly in panels:
        d.polygon(to_px(poly), fill=PANEL_FILL, outline=PANEL_EDGE, width=1)
    img = Image.alpha_composite(img, overlay)

    _draw_north_arrow(img, width)
    m_per_px = 156543.03392 * math.cos(math.radians(lat_c)) / 2 ** z / scale
    _draw_scale_bar(img, m_per_px, width, height)
    if has_imagery:
        _draw_label(img, src.attribution, (width - 8, height - 8), anchor="rd", size=max(12, width // 75))

    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=88)
    return buf.getvalue(), has_imagery


def _draw_label(img, text, xy, anchor="la", size=14):
    d = ImageDraw.Draw(img, "RGBA")
    font = _font(size)
    box = d.textbbox(xy, text, font=font, anchor=anchor)
    d.rectangle((box[0] - 4, box[1] - 3, box[2] + 4, box[3] + 3), fill=(255, 255, 255, 215))
    d.text(xy, text, font=font, fill=(30, 35, 48), anchor=anchor)


def _draw_north_arrow(img, width):
    d = ImageDraw.Draw(img, "RGBA")
    s = max(28, width // 40)
    x, y = width - s - 16, 16
    d.ellipse((x - 6, y - 6, x + s + 6, y + s * 1.6 + 6), fill=(255, 255, 255, 215))
    mid = x + s / 2
    d.polygon([(mid, y), (x + s * 0.15, y + s), (mid, y + s * 0.75)], fill=(30, 35, 48))
    d.polygon([(mid, y), (x + s * 0.85, y + s), (mid, y + s * 0.75)], fill=(120, 125, 135))
    d.text((mid, y + s * 1.05), "Β", font=_font(int(s * 0.5)), fill=(30, 35, 48), anchor="ma")


def _draw_scale_bar(img, m_per_px, width, height):
    target = m_per_px * width / 5
    nice = min((n for n in (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000) if n >= target / 2),
               key=lambda n: abs(n - target), default=5000)
    bar = nice / m_per_px
    d = ImageDraw.Draw(img, "RGBA")
    x, y = 16, height - 16
    h = max(8, width // 160)
    font = _font(max(12, width // 60))
    label = f"{nice} m" if nice < 1000 else f"{nice // 1000} km"
    d.rectangle((x - 6, y - h - 30, x + bar + 8, y + 6), fill=(255, 255, 255, 215))
    d.rectangle((x, y - h, x + bar / 2, y), fill=(30, 35, 48))
    d.rectangle((x + bar / 2, y - h, x + bar, y), fill=(255, 255, 255), outline=(30, 35, 48))
    d.text((x, y - h - 4), "0", font=font, fill=(30, 35, 48), anchor="ld")
    d.text((x + bar, y - h - 4), label, font=font, fill=(30, 35, 48), anchor="rd")
