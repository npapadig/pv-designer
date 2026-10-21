"""Static map picture of a project's layout, for the PDF report.

Downloads Esri satellite tiles around the drawn areas, stitches them and draws
the areas, keep-outs and panels on top, plus a north arrow and a scale bar.
Without internet the shapes are drawn on a plain background instead.
"""
from __future__ import annotations

import io
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
TILEMAP_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/{z}/{y}/{x}/1/1?f=json"
ATTRIBUTION = "Εικόνα: Esri, Maxar"
TILE = 256
DEFAULT_NATIVE_ZOOM = 19
FONT_PATH = Path(__file__).resolve().parent / "fonts" / "DejaVuSans.ttf"

AREA_COLOR = (245, 158, 11)
KEEPOUT_COLOR = (239, 68, 68)
PANEL_FILL = (37, 99, 235, 210)
PANEL_EDGE = (219, 234, 254, 255)


def _world_px(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = TILE * 2 ** z
    lat_r = math.radians(max(min(lat, 85.0), -85.0))
    x = (lon + 180.0) / 360.0 * n
    y = (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n
    return x, y


def _fetch_tile(client: httpx.Client, z: int, x: int, y: int) -> Image.Image | None:
    try:
        r = client.get(TILE_URL.format(z=z, x=x, y=y))
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def _native_zoom(client: httpx.Client, lat: float, lon: float) -> int:
    """Highest zoom with real imagery here (Esri serves placeholder tiles above it)."""
    for z in range(20, 16, -1):
        x, y = (int(v // TILE) for v in _world_px(lat, lon, z))
        try:
            d = client.get(TILEMAP_URL.format(z=z, x=x, y=y)).json()
        except Exception:
            return DEFAULT_NATIVE_ZOOM
        if d.get("data") and d["data"][0] == 1:
            return z
    return 17


def _font(size: int):
    try:
        return ImageFont.truetype(str(FONT_PATH), size)
    except OSError:
        return ImageFont.load_default()


def render_layout(
    areas: list, keepouts: list, panels: list,
    width: int = 1600, height: int = 1000, imagery: bool = True,
) -> tuple[bytes, bool]:
    """Return (JPEG bytes, whether satellite imagery is shown)."""
    pts = [p for poly in (areas or panels) for p in poly]
    if not pts:
        raise ValueError("Δεν υπάρχει σχεδιασμένη περιοχή.")
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    lat_c = (min(lats) + max(lats)) / 2
    lon_c = (min(lons) + max(lons)) / 2

    def frame(z: int, min_crop: float):
        """Zoom out until the shapes (plus a margin) fit, then crop around them with the picture's aspect."""
        while z > 3:
            x0, y0 = _world_px(max(lats), min(lons), z)
            x1, y1 = _world_px(min(lats), max(lons), z)
            if (x1 - x0) * 1.35 <= width and (y1 - y0) * 1.35 <= height:
                break
            z -= 1
        crop_w = max((x1 - x0) * 1.35, (y1 - y0) * 1.35 * width / height, min_crop)
        crop_h = crop_w * height / width
        return z, (x0 + x1 - crop_w) / 2, (y0 + y1 - crop_h) / 2, crop_w, crop_h

    has_imagery = False
    if imagery:
        with httpx.Client(timeout=10.0, headers={"User-Agent": "pv-designer"}) as client:
            # Small roofs get enlarged, but at most 4x so the imagery stays sharp enough.
            z, left, top, crop_w, crop_h = frame(_native_zoom(client, lat_c, lon_c), width / 4)
            tx0, ty0 = int(left // TILE), int(top // TILE)
            tx1, ty1 = int((left + crop_w) // TILE), int((top + crop_h) // TILE)
            coords = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
            with ThreadPoolExecutor(8) as pool:
                tiles = list(pool.map(lambda c: _fetch_tile(client, z, *c), coords))
        if sum(t is not None for t in tiles) >= len(tiles) / 2:
            has_imagery = True
            mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE), (200, 200, 200))
            for (tx, ty), t in zip(coords, tiles):
                if t is not None:
                    mosaic.paste(t, ((tx - tx0) * TILE, (ty - ty0) * TILE))
            ox, oy = left - tx0 * TILE, top - ty0 * TILE
            base = mosaic.resize((width, height), Image.LANCZOS, box=(ox, oy, ox + crop_w, oy + crop_h))
    if not has_imagery:
        # No picture to keep sharp, so fill the frame with the shapes.
        z, left, top, crop_w, crop_h = frame(22, 0)
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
        _draw_label(img, ATTRIBUTION, (width - 8, height - 8), anchor="rd", size=max(12, width // 75))

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
