"""Single-line electrical diagram (μονογραμμικό) of the PV system, one A4 landscape PDF page.

Drawn from the electrical design of the project (inverters, MPPTs, strings, modules per string). The protection
devices and cable sections are the electrician's decision: the diagram shows indicative values (breaker size from
the inverter AC current) or empty "……" fields, and project["single_line"] may override any of them:
    ac_breaker_a, rcd_ma, ac_cable, dc_cable, earthing
The diagram always says that it must be checked and signed by the responsible engineer.
"""
from __future__ import annotations

import io
import math
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas

from . import i18n, report

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#4b5563")
PV_FILL = colors.HexColor("#bfdbfe")
INV_FILL = colors.HexColor("#fde68a")
BOX_FILL = colors.HexColor("#f3f4f6")
BREAKERS = [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125]
BLANK = "……"


def ac_current(pac_w: float, phases: int) -> float:
    """Rated AC current (A) of an inverter on 230 V single-phase or 400 V three-phase."""
    return pac_w / (230 * phases if phases == 1 else math.sqrt(3) * 400)


def breaker_for(current_a: float) -> int:
    """Smallest standard breaker rating that is not below the rated current."""
    return next((b for b in BREAKERS if b >= current_a), BREAKERS[-1])


def _box(c, x, y, w, h, lines, fill=BOX_FILL, bold_first=True, size=7):
    c.saveState()
    c.setFillColor(fill)
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.rect(x, y, w, h, stroke=1, fill=1)
    c.setFillColor(INK)
    n = len(lines)
    lh = size + 2.5
    top = y + h / 2 + (n - 1) * lh / 2 - size * 0.3
    for i, line in enumerate(lines):
        c.setFont("DejaVu-Bold" if (i == 0 and bold_first) else "DejaVu", size)
        c.drawCentredString(x + w / 2, top - i * lh, line)
    c.restoreState()


def _line(c, x1, y1, x2, y2, width=1.2):
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    c.restoreState()


def _mppt_label(d: dict, inv_idx: int, j: int) -> tuple[int, str]:
    """(number of strings, text) of MPPT j of inverter inv_idx."""
    tr = report.tr
    per = d["per_inverter"][inv_idx]
    n = per["mppts"][j]
    if n == 0:
        return 0, ""
    lengths = {d["modules_per_string"]}
    if d.get("faces") and per.get("mppt_faces"):
        lengths = {d["faces"][f]["modules_per_string"] for f in per["mppt_faces"][j]
                   if d["faces"][f]["modules_per_string"]} or lengths
    mod = "/".join(str(x) for x in sorted(lengths))
    return n, f"{n} × string {mod} {tr('πάνελ')}"


def build_single_line_pdf(project: dict, lang: str = "el") -> bytes:
    """One-page PDF. Raises ValueError when there is no electrical design yet."""
    token = report._LANG.set(lang if lang in i18n.LANGS else "el")
    try:
        return _build(project)
    finally:
        report._LANG.reset(token)


def _build(project: dict) -> bytes:
    tr, num = report.tr, report.num
    d = (project.get("electrical") or {}).get("design")
    if not d or not d.get("per_inverter"):
        raise ValueError("Κάνε πρώτα τον ηλεκτρολογικό σχεδιασμό (βήμα «Inverter»).")
    inv = d["inverter"]
    s = project.get("settings") or {}
    info = project.get("report_info") or {}
    over = project.get("single_line") or {}
    k = d["n_inverters"]
    phases = int(inv.get("phases") or 3)
    i_ac = ac_current(inv["pac_w"], phases)
    brk = over.get("ac_breaker_a") or breaker_for(i_ac)
    total_i = i_ac * k
    main_brk = over.get("ac_breaker_a") if k == 1 and over.get("ac_breaker_a") else breaker_for(total_i)
    volt = "230 V" if phases == 1 else "400/230 V"
    net = tr("1~ 230 V, 50 Hz") if phases == 1 else tr("3~ 400/230 V, 50 Hz")

    page_w, page_h = landscape(A4)
    margin = 8 * mm
    foot_h = 30 * mm
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    name = project.get("name") or tr("Έργο")
    c.setTitle(f"{tr('Μονογραμμικό ηλεκτρολογικό σχέδιο')} – {name}")
    c.setAuthor(info.get("author") or "PV Designer")
    c.setStrokeColor(INK)
    c.setLineWidth(1.2)
    c.rect(margin, margin, page_w - 2 * margin, page_h - 2 * margin)
    c.setFillColor(INK)
    c.setFont("DejaVu-Bold", 12)
    c.drawString(margin + 6 * mm, page_h - margin - 9 * mm, tr("ΜΟΝΟΓΡΑΜΜΙΚΟ ΗΛΕΚΤΡΟΛΟΓΙΚΟ ΣΧΕΔΙΟ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ"))

    # --- left: PV strings per MPPT, then inverters ---
    rows = [(i, j) for i in range(k) for j in range(inv["n_mppt"]) if _mppt_label(d, i, j)[0]]
    top = page_h - margin - 18 * mm
    bottom = margin + foot_h + 6 * mm
    row_h = min(17 * mm, (top - bottom) / max(len(rows), 1))
    pv_w, pv_x = 52 * mm, margin + 6 * mm
    inv_x, inv_w = pv_x + pv_w + 40 * mm, 46 * mm
    y = top
    inv_ys: dict[int, list[float]] = {}
    mod_name = s.get("panel_name") or f"{num(s.get('panel_power_w'))} W"
    for i, j in rows:
        n, label = _mppt_label(d, i, j)
        cy = y - row_h / 2
        _box(c, pv_x, cy - row_h * 0.36, pv_w, row_h * 0.72,
             [label, f"{mod_name}", f"MPPT {j + 1}" + (f" / {tr('Inverter')} {i + 1}" if k > 1 else "")],
             fill=PV_FILL, size=6.5)
        _line(c, pv_x + pv_w, cy, inv_x, cy)
        inv_ys.setdefault(i, []).append(cy)
        y -= row_h
    # DC labels on the first line
    if rows:
        cy0 = inv_ys[rows[0][0]][0]
        c.setFont("DejaVu", 6.5)
        c.setFillColor(MUTED)
        c.drawCentredString(pv_x + pv_w + 20 * mm, cy0 + 2.5, "DC")
        c.drawCentredString(pv_x + pv_w + 20 * mm, cy0 - 7.5, f"{tr('καλώδιο ΦΒ')} {over.get('dc_cable') or BLANK} mm²")
        c.setFillColor(INK)
    ac_xs = []
    for i, ys in inv_ys.items():
        y1, y2 = min(ys), max(ys)
        pad = row_h * 0.4
        _box(c, inv_x, y1 - pad, inv_w, (y2 - y1) + 2 * pad,
             [tr("Inverter") + (f" {i + 1}" if k > 1 else ""), inv.get("name") or "",
              f"{num(inv['pac_w'] / 1000, 1)} kW · {num(inv.get('eff_pct'), 1)} %",
              f"Vdc max {num(inv.get('vdc_max'))} V · MPPT {num(inv.get('v_mppt_min'))}–{num(inv.get('v_mppt_max'))} V",
              f"{tr('DC διακόπτης και αποζεύκτης στον inverter')}"], fill=INV_FILL, size=6.5)
        ac_xs.append(((y1 + y2) / 2, inv_x + inv_w))

    # --- right: AC chain ---
    bus_x = inv_x + inv_w + 16 * mm
    mid_y = (top + bottom) / 2
    for ay, ax in ac_xs:
        _line(c, ax, ay, bus_x, ay)
    if len(ac_xs) > 1:
        _line(c, bus_x, min(a[0] for a in ac_xs), bus_x, max(a[0] for a in ac_xs))
    _line(c, bus_x, mid_y, bus_x + 6 * mm, mid_y)
    c.setFont("DejaVu", 6.5)
    c.setFillColor(MUTED)
    c.drawCentredString(inv_x + inv_w + 8 * mm, ac_xs[0][0] + 2.5, "AC")
    c.setFillColor(INK)

    chain = [
        ([tr("Πίνακας ΦΒ (AC)"), f"{tr('Αυτόματος')} {num(brk)} A" + (f" × {k}" if k > 1 else ""),
          f"{tr('Ρελέ διαρροής')} {over.get('rcd_ma') or 30} mA", tr("Αντικεραυνική AC (SPD)")], 40),
        ([tr("Γενικός πίνακας"), f"{tr('Γενικός αυτόματος')} {num(main_brk)} A", net], 36),
        ([tr("Μετρητής ΔΕΔΔΗΕ"), tr("αμφίδρομος"), tr("(συμψηφισμός)")], 30),
        ([tr("Δίκτυο ΔΕΔΔΗΕ"), net], 28),
    ]
    x = bus_x + 6 * mm
    avail = page_w - margin - 4 * mm - x
    gap = 6 * mm
    scale_w = min(1.0, (avail - gap * (len(chain) - 1)) / (sum(w for _, w in chain) * mm))
    for idx, (lines, w) in enumerate(chain):
        bw = w * mm * scale_w
        bh = 24 * mm
        _box(c, x, mid_y - bh / 2, bw, bh, lines, size=6)
        if idx < len(chain) - 1:
            _line(c, x + bw, mid_y, x + bw + gap, mid_y)
        x += bw + gap
    # earthing
    c.setFont("DejaVu", 6.5)
    c.setFillColor(MUTED)
    c.drawString(bus_x + 6 * mm, mid_y - 22 * mm,
                 f"{tr('Γείωση / ισοδυναμικός ζυγός')}: {over.get('earthing') or BLANK}  ·  "
                 f"{tr('καλώδιο AC')} {over.get('ac_cable') or BLANK} mm²")
    c.setFillColor(INK)

    # --- footer: title block ---
    fy = margin
    c.setLineWidth(0.8)
    c.line(margin, fy + foot_h, page_w - margin, fy + foot_h)
    cols = [margin + 6 * mm, margin + 86 * mm, margin + 166 * mm, margin + 220 * mm]
    items = [
        [(tr("Έργο"), project.get("name") or "–"), (tr("Πελάτης"), info.get("client") or "–"),
         (tr("Διεύθυνση"), info.get("address") or "–")],
        [(tr("Εγκατεστημένη ισχύς (DC)"), f"{num(d.get('dc_kwp'), 2)} kWp"),
         (tr("Ισχύς AC"), f"{num(d.get('ac_kw'), 2)} kW"),
         (tr("Αριθμός πάνελ"), f"{num(d.get('modules_used'))} ({d.get('n_strings')} strings)")],
        [(tr("Συντάκτης"), info.get("author") or "–"),
         (tr("Ημερομηνία"), date.today().strftime("%d/%m/%Y")), (tr("Κλίμακα"), tr("Χωρίς κλίμακα"))],
    ]
    for x0, rows_ in zip(cols, items):
        yy = fy + foot_h - 7 * mm
        for label, value in rows_:
            c.setFont("DejaVu", 6.5)
            c.setFillColor(MUTED)
            c.drawString(x0, yy, label)
            c.setFillColor(INK)
            c.setFont("DejaVu-Bold", 7.5)
            c.drawString(x0 + 24 * mm, yy, str(value)[:48])
            yy -= 6 * mm
    c.setFont("DejaVu", 6.5)
    c.setFillColor(colors.HexColor("#b91c1c"))
    c.drawString(margin + 6 * mm, fy + 3 * mm,
                 tr("Ενδεικτικό σχέδιο: οι προστασίες και οι διατομές καλωδίων πρέπει να ελεγχθούν και να υπογραφούν "
                    "από τον υπεύθυνο μηχανικό/ηλεκτρολόγο."))
    c.showPage()
    c.save()
    return buf.getvalue()


def filename(project: dict, lang: str = "el") -> str:
    base = report.filename(project, lang)[:-4]
    return i18n.tr("Μονογραμμικό ΦΒ - {name}.pdf", lang).format(name=base.split(" - ", 1)[-1])
