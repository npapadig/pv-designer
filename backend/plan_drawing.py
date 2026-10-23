"""Clean floor-plan drawing of the panel layout (vector PDF, to scale) for permit applications (e.g. DEDDIE).

No satellite picture: white background, the installation area outline with side lengths, obstacles, the panels,
north arrow, scale bar, a standard scale (1:50, 1:100, ...) and a title block with the system data.
Texts go through report.tr(), so the drawing also comes out in English.
"""
from __future__ import annotations

import io
import math
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.units import mm
from pyproj import Transformer
from reportlab.pdfgen import canvas as rl_canvas

from . import i18n, report

PAPERS = {"a4": landscape(A4), "a3": landscape(A3)}
SCALES = [20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 5000]
BLOCK_W = 78 * mm
M_LAT = 110574.0
M_LON = 111320.0

INK = colors.HexColor("#111827")
PANEL_FILL = colors.HexColor("#bfdbfe")
PANEL_EDGE = colors.HexColor("#1e3a8a")
KEEPOUT_FILL = colors.HexColor("#d1d5db")


def _to_metres(polys: list, lat0: float, lon0: float) -> list[list[tuple[float, float]]]:
    k = math.cos(math.radians(lat0))
    return [[((lon - lon0) * M_LON * k, (lat - lat0) * M_LAT) for lat, lon in poly] for poly in polys]


def pick_scale(width_m: float, height_m: float, avail_w: float, avail_h: float) -> int:
    """Smallest standard scale 1:N at which a width_m x height_m drawing fits in avail_w x avail_h points."""
    for n in SCALES:
        if width_m * 1000 / n * mm <= avail_w and height_m * 1000 / n * mm <= avail_h:
            return n
    return SCALES[-1]


def _nice_length(m: float) -> float:
    """A round length (1, 2, 5 x 10^k metres) not larger than m."""
    p = 10 ** math.floor(math.log10(max(m, 1e-6)))
    for f in (5, 2, 1):
        if f * p <= m:
            return f * p
    return p


def egsa87(lat: float, lon: float) -> tuple[float, float]:
    """(x, y) in metres in the Greek grid ΕΓΣΑ87 (EPSG:2100), as used by Greek topographic diagrams."""
    return _EGSA.transform(lon, lat)


_EGSA = Transformer.from_crs("EPSG:4326", "EPSG:2100", always_xy=True)


def _poly_path(c: rl_canvas.Canvas, pts: list[tuple[float, float]]):
    p = c.beginPath()
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    p.close()
    return p


def _north_arrow(c, x: float, y: float, size: float):
    c.saveState()
    c.setStrokeColor(INK)
    c.setFillColor(INK)
    c.setLineWidth(0.8)
    c.circle(x, y, size * 0.5, stroke=1, fill=0)
    p = c.beginPath()
    p.moveTo(x, y + size * 0.5)
    p.lineTo(x - size * 0.16, y - size * 0.3)
    p.lineTo(x, y - size * 0.12)
    p.lineTo(x + size * 0.16, y - size * 0.3)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFont("DejaVu-Bold", size * 0.4)
    c.drawCentredString(x, y + size * 0.62, report.tr("Β", context="north"))
    c.restoreState()


def _scale_bar(c, x: float, y: float, scale: int):
    metres = _nice_length(60 * mm * scale / 1000)
    length = metres * 1000 / scale * mm
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.line(x, y, x + length, y)
    for i in range(5):
        tx = x + length * i / 4
        c.line(tx, y, tx, y + (3 if i % 2 == 0 else 2) * mm)
    c.setFillColor(INK)
    c.setFont("DejaVu", 7)
    c.drawString(x, y - 9, "0")
    c.drawRightString(x + length, y - 9, f"{report.num(metres)} m")
    c.restoreState()


def _title_block(c, x: float, y0: float, w: float, h: float, rows: list[tuple[str, str]], project: dict,
                 scale: int, info: dict):
    """The right-hand column: titles on top, data table below, scale/date at the bottom."""
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.rect(x, y0, w, h)
    top = y0 + h
    c.setFillColor(INK)
    c.setFont("DejaVu-Bold", 11)
    c.drawString(x + 4 * mm, top - 9 * mm, report.tr("ΚΑΤΟΨΗ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ"))
    c.setFont("DejaVu", 8)
    c.drawString(x + 4 * mm, top - 14 * mm, report.tr("Διάταξη πάνελ"))
    c.line(x, top - 18 * mm, x + w, top - 18 * mm)

    y = top - 18 * mm
    head = [(report.tr("Έργο"), project.get("name") or "–"),
            (report.tr("Πελάτης"), info.get("client") or "–"),
            (report.tr("Διεύθυνση"), info.get("address") or "–")]
    for item in head + rows:
        label, value = item
        y -= 6.2 * mm
        c.setFont("DejaVu", 7)
        c.setFillColor(colors.HexColor("#4b5563"))
        c.drawString(x + 4 * mm, y + 1.5 * mm, label)
        c.setFillColor(INK)
        c.setFont("DejaVu-Bold", 8)
        # Keep long values (addresses) inside the block.
        text = str(value)
        while c.stringWidth(text, "DejaVu-Bold", 8) > w - 36 * mm and len(text) > 4:
            text = text[:-2]
        if text != str(value):
            text = text.rstrip() + "…"
        c.drawRightString(x + w - 4 * mm, y + 1.5 * mm, text)
        c.setStrokeColor(colors.HexColor("#e5e7eb"))
        c.setLineWidth(0.4)
        c.line(x + 3 * mm, y, x + w - 3 * mm, y)
    # bottom: scale, date, author
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.line(x, y0 + 26 * mm, x + w, y0 + 26 * mm)
    c.setFillColor(INK)
    c.setFont("DejaVu-Bold", 10)
    c.drawString(x + 4 * mm, y0 + 18 * mm, f"{report.tr('Κλίμακα')} 1:{scale}")
    c.setFont("DejaVu", 8)
    c.drawString(x + 4 * mm, y0 + 12 * mm, f"{report.tr('Ημερομηνία')}: {date.today().strftime('%d/%m/%Y')}")
    c.drawString(x + 4 * mm, y0 + 6 * mm, f"{report.tr('Συντάκτης')}: {info.get('author') or '–'}")
    c.restoreState()


def build_plan_pdf(project: dict, lang: str = "el", paper: str = "a4") -> bytes:
    """One-page PDF of the layout. Raises ValueError when nothing is drawn yet."""
    token = report._LANG.set(lang if lang in i18n.LANGS else "el")
    try:
        return _build(project, paper)
    finally:
        report._LANG.reset(token)


def _build(project: dict, paper: str) -> bytes:
    tr, num = report.tr, report.num
    areas = project.get("areas") or []
    keepouts = project.get("keepouts") or []
    layout = project.get("layout") or {}
    panels = layout.get("panels") or []
    if not (areas or panels):
        raise ValueError("Δεν υπάρχει σχεδιασμένη περιοχή.")
    pts = [p for poly in (areas + panels) for p in poly]
    lat0 = sum(p[0] for p in pts) / len(pts)
    lon0 = sum(p[1] for p in pts) / len(pts)
    a_m, k_m, p_m = (_to_metres(g, lat0, lon0) for g in (areas, keepouts, panels))
    xs = [x for poly in a_m + p_m for x, _ in poly]
    ys = [y for poly in a_m + p_m for _, y in poly]
    w_m, h_m = max(xs) - min(xs), max(ys) - min(ys)

    page_w, page_h = PAPERS.get(paper, PAPERS["a4"])
    margin = 10 * mm
    pad = 22 * mm  # room for north arrow, side lengths and the scale bar
    avail_w = page_w - 2 * margin - BLOCK_W - 2 * pad
    avail_h = page_h - 2 * margin - 2 * pad
    scale = pick_scale(w_m, h_m, avail_w, avail_h)
    k = 1000 / scale * mm  # points per metre
    # Centre the drawing in the free area.
    area_x0 = margin + pad
    cx = area_x0 + avail_w / 2 - (min(xs) + max(xs)) / 2 * k
    cy = margin + pad + avail_h / 2 - (min(ys) + max(ys)) / 2 * k

    def pt(p):
        return (cx + p[0] * k, cy + p[1] * k)

    buf = io.BytesIO()
    name = project.get("name") or tr("Έργο")
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    c.setTitle(f"{tr('Κάτοψη φωτοβολταϊκού συστήματος')} – {name}")
    c.setAuthor((project.get("report_info") or {}).get("author") or "PV Designer")

    c.setStrokeColor(INK)
    c.setLineWidth(1.2)
    c.rect(margin, margin, page_w - 2 * margin, page_h - 2 * margin)

    # installation area: dashed outline, with side lengths
    c.setStrokeColor(INK)
    c.setLineWidth(1)
    c.setDash(5, 3)
    for poly in a_m:
        c.drawPath(_poly_path(c, [pt(p) for p in poly]), stroke=1, fill=0)
    c.setDash()
    # obstacles
    c.setStrokeColor(colors.HexColor("#6b7280"))
    c.setFillColor(KEEPOUT_FILL)
    c.setLineWidth(0.7)
    for poly in k_m:
        c.drawPath(_poly_path(c, [pt(p) for p in poly]), stroke=1, fill=1)
    # panels
    c.setStrokeColor(PANEL_EDGE)
    c.setFillColor(PANEL_FILL)
    c.setLineWidth(0.4)
    for poly in p_m:
        c.drawPath(_poly_path(c, [pt(p) for p in poly]), stroke=1, fill=1)
    # side lengths of the area (outside the outline)
    c.setFillColor(INK)
    c.setFont("DejaVu", 7)
    for poly in a_m:
        n = len(poly)
        sign = 1 if sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n)) > 0 else -1
        for i in range(n):
            (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
            length = math.hypot(x2 - x1, y2 - y1)
            if length * k < 14 * mm:
                continue
            mx, my = pt(((x1 + x2) / 2, (y1 + y2) / 2))
            nx, ny = (y2 - y1) / length * sign, -(x2 - x1) / length * sign  # outward normal
            ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
            if ang > 90 or ang <= -90:
                ang += 180
            c.saveState()
            c.translate(mx + nx * 3.2 * mm, my + ny * 3.2 * mm)
            c.rotate(ang)
            c.drawCentredString(0, -2.5, f"{num(length, 2)} m")
            c.restoreState()

    # vertex numbers K1, K2, ... (match the coordinates table on page 2)
    c.setFont("DejaVu-Bold", 7)
    c.setFillColor(colors.HexColor("#b91c1c"))
    n_vertex = 0
    for poly in a_m:
        for p in poly:
            n_vertex += 1
            x, y = pt(p)
            c.circle(x, y, 1.1, stroke=0, fill=1)
            c.drawString(x + 2, y + 2, f"K{n_vertex}")
    c.setFillColor(INK)
    _north_arrow(c, margin + 14 * mm, page_h - margin - 24 * mm, 12 * mm)
    _scale_bar(c, margin + 8 * mm, margin + 9 * mm, scale)
    # legend
    lx, ly = margin + 8 * mm, margin + 18 * mm
    c.setFont("DejaVu", 7)
    c.setLineWidth(0.4)
    c.setStrokeColor(PANEL_EDGE)
    c.setFillColor(PANEL_FILL)
    c.rect(lx, ly, 6 * mm, 3 * mm, stroke=1, fill=1)
    c.setFillColor(INK)
    c.drawString(lx + 8 * mm, ly + 0.8, tr("Πάνελ"))
    c.setStrokeColor(colors.HexColor("#6b7280"))
    c.setFillColor(KEEPOUT_FILL)
    c.rect(lx + 28 * mm, ly, 6 * mm, 3 * mm, stroke=1, fill=1)
    c.setFillColor(INK)
    c.drawString(lx + 36 * mm, ly + 0.8, tr("Εμπόδια"))
    c.setStrokeColor(INK)
    c.setDash(3, 2)
    c.line(lx + 60 * mm, ly + 1.5 * mm, lx + 66 * mm, ly + 1.5 * mm)
    c.setDash()
    c.drawString(lx + 68 * mm, ly + 0.8, tr("Περιοχή εγκατάστασης"))

    s = project.get("settings") or {}
    info = project.get("report_info") or {}
    power = s.get("panel_power_w")
    rows = [
        (tr("Εγκατεστημένη ισχύς (DC)"), f"{num(layout.get('kwp'), 2)} kWp"),
        (tr("Αριθμός πάνελ"), num(layout.get("count") or len(panels))),
        (tr("Ισχύς πάνελ"), f"{num(power)} W"),
        (tr("Διαστάσεις πάνελ"), f"{num((s.get('panel_length_m') or 0) * 1000)} × "
                                 f"{num((s.get('panel_width_m') or 0) * 1000)} mm"),
        (tr("Τοποθέτηση"), tr(report.MOUNTING.get(s.get("mounting"), "–"))),
    ]
    if not report.face_rows(project):
        rows += [(tr("Κλίση"), f"{num(s.get('tilt_deg'))}°"),
                 (tr("Αζιμούθιο"), f"{num(s.get('azimuth_deg'))}° ({report.compass(s.get('azimuth_deg', 180))})")]
    rows.append((tr("Επιφάνεια πάνελ"), f"{num(layout.get('module_area_m2'), 1)} m²"))
    _title_block(c, page_w - margin - BLOCK_W, margin, BLOCK_W, page_h - 2 * margin, rows, project, scale, info)
    c.showPage()
    if areas:
        _coords_page(c, areas, project, page_w, page_h, margin)
    c.save()
    return buf.getvalue()


def _coords_page(c, areas: list, project: dict, page_w: float, page_h: float, margin: float):
    """Page 2: coordinates (ΕΓΣΑ87 and WGS84) of the corners of the installation area."""
    tr, num = report.tr, report.num
    c.setStrokeColor(INK)
    c.setLineWidth(1.2)
    c.rect(margin, margin, page_w - 2 * margin, page_h - 2 * margin)
    c.setFillColor(INK)
    c.setFont("DejaVu-Bold", 13)
    y = page_h - margin - 14 * mm
    c.drawString(margin + 10 * mm, y, tr("Συντεταγμένες κορυφών περιοχής εγκατάστασης"))
    c.setFont("DejaVu", 8)
    y -= 6 * mm
    c.drawString(margin + 10 * mm, y, f"{project.get('name') or ''}   ·   {tr('ΕΓΣΑ87 (EPSG:2100) σε μέτρα· WGS84 σε μοίρες')}")
    cols = [margin + 10 * mm, margin + 30 * mm, margin + 80 * mm, margin + 130 * mm, margin + 180 * mm]
    y -= 10 * mm
    c.setFont("DejaVu-Bold", 8)
    for x, head in zip(cols, ["", "X (ΕΓΣΑ87)", "Y (ΕΓΣΑ87)", tr("Γεωγρ. πλάτος"), tr("Γεωγρ. μήκος")]):
        c.drawString(x, y, head)
    c.line(margin + 10 * mm, y - 2, page_w - margin - 10 * mm, y - 2)
    c.setFont("DejaVu", 8)
    i = 0
    for poly in areas:
        for lat, lon in poly:
            i += 1
            y -= 5.5 * mm
            if y < margin + 12 * mm:
                break
            ex, ey = egsa87(lat, lon)
            for x, text in zip(cols, [f"K{i}", f"{ex:,.2f}".replace(",", " "), f"{ey:,.2f}".replace(",", " "),
                                      f"{lat:.6f}", f"{lon:.6f}"]):
                c.drawString(x, y, text)
    c.setFont("DejaVu", 7)
    c.setFillColor(colors.HexColor("#4b5563"))
    c.drawString(margin + 10 * mm, margin + 7 * mm, tr("Οι συντεταγμένες προκύπτουν από το σχέδιο στο χάρτη (ενδεικτικές, ακρίβεια εικόνας χάρτη)· "
                                                      "δεν αντικαθιστούν το σφραγισμένο τοπογραφικό διάγραμμα."))
    c.showPage()


def filename(project: dict, lang: str = "el") -> str:
    base = report.filename(project, lang)[:-4]
    return i18n.tr("Κάτοψη ΦΒ - {name}.pdf", lang).format(name=base.split(" - ", 1)[-1])
