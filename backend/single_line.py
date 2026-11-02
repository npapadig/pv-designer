"""Single-line electrical diagram (μονογραμμικό) of the PV system, one A4 landscape PDF page.

Drawn from the electrical design of the project (inverters, MPPTs, strings, modules per string), left to right in
the direction of the power: PV strings → DC cables → DC switch-disconnector and DC SPD → inverter → AC breaker and
RCD → AC SPD and AC isolator (PV board) → main board → line to the meter → bidirectional DEDDIE meter → grid.
The symbols follow IEC 60617 in a simplified form and the devices carry IEC 81346 style codes (-G, -W, -Q, -F, -T, -P).

The protection devices and cable sections are the electrician's decision: the diagram shows indicative values
(breaker size from the inverter AC current, curve C, 6 kA, H1Z2Z2-K 1×6 mm², RCD type B) or empty "……" fields,
and project["single_line"] may override any of them (see DEFAULTS and `values`):
    ac_breaker_a, ac_curve, ac_icu_ka, rcd_ma, rcd_type, ac_cable, ac_cable_type, dc_cable, dc_cable_type,
    meter_cable, pe_cable, string_fuse_a, spd_dc_type, spd_ac_type, earthing, earthing_system, transformer,
    scheme (net_billing / net_metering / self), battery_coupling (dc / ac), eps (true / false)
project["report_info"]["supply_no"] is the DEDDIE supply number of the title block.
The diagram always says that it must be checked and signed by the responsible engineer.
"""
from __future__ import annotations

import io
import math
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, A4
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas as rl_canvas

from . import battery_report, brand, i18n, report

INK = colors.HexColor("#111827")
MUTED = colors.HexColor("#4b5563")
DC_C = colors.HexColor("#1d4ed8")
PE_C = colors.HexColor("#15803d")
RED = colors.HexColor("#b91c1c")
LIGHT = colors.HexColor("#eff6ff")
BOARD = colors.HexColor("#6b7280")
BREAKERS = [6, 10, 13, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125]
BLANK = "……"

# Indicative values that project["single_line"] may override.
DEFAULTS = {
    "ac_curve": "C", "ac_icu_ka": 6, "rcd_ma": 30, "rcd_type": "B",
    "dc_cable_type": "H1Z2Z2-K", "dc_cable": "6", "ac_cable_type": "J1VV-R",
    "spd_dc_type": "2", "spd_ac_type": "2",
}
SCHEMES = {"net_billing": "Net billing", "net_metering": "Net metering", "self": "μόνο ιδιοκατανάλωση"}


def ac_current(pac_w: float, phases: int) -> float:
    """Rated AC current (A) of an inverter on 230 V single-phase or 400 V three-phase."""
    return pac_w / (230 * phases if phases == 1 else math.sqrt(3) * 400)


def breaker_for(current_a: float) -> int:
    """Smallest standard breaker rating that is not below the rated current."""
    return next((b for b in BREAKERS if b >= current_a), BREAKERS[-1])


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


def _scheme(project: dict, over: dict) -> str:
    """The connection scheme: the override, else the one of the financial analysis, else net billing."""
    if over.get("scheme") in SCHEMES:
        return over["scheme"]
    fin = project.get("finance") if isinstance(project.get("finance"), dict) else {}
    rep = fin.get("report") if isinstance(fin.get("report"), dict) else {}
    for row in rep.get("summary") or []:
        if isinstance(row, (list, tuple)) and len(row) == 2 and row[0] == "Τρόπος σύνδεσης":
            text = str(row[1]).lower()
            return "net_metering" if "metering" in text else "self" if "ιδιοκατανάλωση" in text else "net_billing"
    return "net_billing"


def values(project: dict) -> dict:
    """Ratings and texts that the single-line diagram and the technical description share (not translated)."""
    d = project["electrical"]["design"]
    inv = d["inverter"]
    over = project.get("single_line") if isinstance(project.get("single_line"), dict) else {}

    def o(key):
        v = over.get(key)
        return DEFAULTS.get(key) if v in (None, "") else v

    k = d["n_inverters"]
    phases = int(inv.get("phases") or 3)
    i_ac = ac_current(inv["pac_w"], phases)
    brk = over.get("ac_breaker_a") or breaker_for(i_ac)
    main_brk = over.get("ac_breaker_a") if k == 1 and over.get("ac_breaker_a") else breaker_for(i_ac * k)
    isc = (d.get("currents") or {}).get("isc_mppt") or inv.get("isc_max_mppt")
    ex = project.get("existing_pv") if isinstance(project.get("existing_pv"), dict) else {}
    coupling = over.get("battery_coupling") or ex.get("coupling")
    cores = 3 if phases == 1 else 5
    return {
        "k": k, "phases": phases, "i_ac": i_ac, "brk": brk, "main_brk": main_brk,
        "poles": "2P" if phases == 1 else "4P", "cores": cores, "conductors": "L/N/PE" if phases == 1 else "3/N/PE",
        "curve": o("ac_curve"), "icu": o("ac_icu_ka"), "rcd_ma": o("rcd_ma"), "rcd_type": o("rcd_type"),
        "dc_cable": f"{o('dc_cable_type')} 1×{o('dc_cable')} mm²",
        "dc_cable_indicative": not over.get("dc_cable") and not over.get("dc_cable_type"),
        "ac_cable": f"{o('ac_cable_type')} {cores}G{over.get('ac_cable') or BLANK} mm²",
        "ac_cable_type": o("ac_cable_type"), "ac_cable_size": f"{cores}G{over.get('ac_cable') or BLANK} mm²",
        "meter_cable": over.get("meter_cable") or BLANK, "pe_cable": over.get("pe_cable") or BLANK,
        "vdc": inv.get("vdc_max"), "idc": math.ceil(1.25 * isc) if isc else None,
        "string_fuse_a": over.get("string_fuse_a") or None,
        "spd_dc": o("spd_dc_type"), "spd_ac": o("spd_ac_type"),
        "earthing": over.get("earthing") or BLANK, "earthing_system": over.get("earthing_system") or BLANK,
        "transformer": over.get("transformer") or BLANK,
        "scheme": _scheme(project, over),
        "coupling": coupling if coupling in ("ac", "dc") else "dc", "coupling_known": coupling in ("ac", "dc"),
        "eps": over.get("eps"),
        "single_phase_over_5kw": phases == 1 and inv["pac_w"] * k > 5000,
    }


def build_single_line_pdf(project: dict, lang: str = "el") -> bytes:
    """One-page PDF. Raises ValueError when there is no electrical design yet."""
    token = report._LANG.set(lang if lang in i18n.LANGS else "el")
    try:
        return _build(project)
    finally:
        report._LANG.reset(token)


# ---------------------------------------------------------------- drawing helpers
def _txt(c, x, y, s, size=5.2, bold=False, anchor="l", color=INK, maxw=None):
    font = "DejaVu-Bold" if bold else "DejaVu"
    s = str(s)
    if maxw:
        w = c.stringWidth(s, font, size)
        if w > maxw:
            size = max(3.4, size * maxw / w)
    c.setFont(font, size)
    c.setFillColor(color)
    {"l": c.drawString, "c": c.drawCentredString, "r": c.drawRightString}[anchor](x, y, s)


def _wire(c, x1, y1, x2, y2, kind="ac"):
    c.saveState()
    if kind == "dc":
        c.setStrokeColor(DC_C)
        c.setLineWidth(1.0)
    elif kind == "pe":
        c.setStrokeColor(PE_C)
        c.setLineWidth(0.6)
        c.setDash(2.2, 1.4)
    elif kind == "com":
        c.setStrokeColor(MUTED)
        c.setLineWidth(0.5)
        c.setDash(1.2, 1.2)
    elif kind == "thin":
        c.setStrokeColor(INK)
        c.setLineWidth(0.6)
    else:
        c.setStrokeColor(INK)
        c.setLineWidth(1.0)
    c.line(x1, y1, x2, y2)
    c.restoreState()


def _stroke(c, color=INK, width=0.8):
    c.setStrokeColor(color)
    c.setLineWidth(width)
    c.setDash()


def _blade(c, x, y, ln, color):
    """Open contact of a switch, horizontal, from x to x+ln; returns the x of the fixed contact."""
    a, b = x + 0.28 * ln, x + 0.78 * ln
    _stroke(c, color, 1.0)
    c.line(x, y, a, y)
    c.line(a, y, b + 0.04 * ln, y + 0.34 * ln)
    c.line(b, y, x + ln, y)
    return b


def sym_breaker(c, x, y, ln, color=INK):
    """Circuit breaker (IEC 60617 S00287): contact with a cross on the fixed contact."""
    c.saveState()
    b = _blade(c, x, y, ln, color)
    e = 0.09 * ln
    c.setLineWidth(0.8)
    c.line(b - e, y - e, b + e, y + e)
    c.line(b - e, y + e, b + e, y - e)
    c.restoreState()


def sym_switch_disconnector(c, x, y, ln, color=INK):
    """Switch-disconnector (S00290 + S00288): contact with the isolating bar and the load-switch circle."""
    c.saveState()
    b = _blade(c, x, y, ln, color)
    e = 0.11 * ln
    c.setLineWidth(0.8)
    c.line(b, y - e, b, y + e)
    c.setFillColor(colors.white)
    c.circle(b - 0.06 * ln, y + 0.02 * ln, 0.045 * ln, stroke=1, fill=1)
    c.restoreState()


def sym_rcd(c, x, y, ln, color=INK):
    """Residual current device: breaker contact operated by a summation current transformer."""
    c.saveState()
    sym_breaker(c, x, y, ln, color)
    _stroke(c, color, 0.7)
    ex = x + 0.13 * ln
    c.ellipse(ex - 0.05 * ln, y - 0.2 * ln, ex + 0.05 * ln, y + 0.2 * ln, stroke=1, fill=0)
    c.setDash(1.2, 1)
    c.line(ex, y + 0.2 * ln, ex, y + 0.44 * ln)
    c.line(ex, y + 0.44 * ln, x + 0.55 * ln, y + 0.44 * ln)
    c.line(x + 0.55 * ln, y + 0.44 * ln, x + 0.55 * ln, y + 0.2 * ln)
    c.restoreState()


def sym_fuse(c, x, y, ln, color=INK):
    """Fuse (S00362): rectangle with the conductor through it."""
    c.saveState()
    _stroke(c, color, 1.0)
    c.line(x, y, x + ln, y)
    c.setLineWidth(0.8)
    c.setFillColor(colors.white)
    c.rect(x + 0.18 * ln, y - 0.15 * ln, 0.64 * ln, 0.3 * ln, stroke=1, fill=1)
    c.line(x + 0.18 * ln, y, x + 0.82 * ln, y)
    c.restoreState()


def sym_earth(c, x, y, w, color=PE_C):
    """Earth (S00200): three lines getting shorter; (x, y) is the top of the stem."""
    c.saveState()
    _stroke(c, color, 0.8)
    stem = 0.35 * w
    c.line(x, y, x, y - stem)
    for i, f in enumerate((1.0, 0.62, 0.26)):
        yy = y - stem - i * 0.2 * w
        c.line(x - f * w / 2, yy, x + f * w / 2, yy)
    c.restoreState()


def sym_spd(c, x, y, depth, color=INK):
    """Surge protective device: a varistor from the node (x, y) down to earth."""
    c.saveState()
    _stroke(c, color, 0.8)
    c.setFillColor(color)
    c.circle(x, y, 0.55, stroke=0, fill=1)
    bw, bh = 0.26 * depth, 0.4 * depth
    top = y - 0.18 * depth
    c.line(x, y, x, top)
    c.setFillColor(colors.white)
    c.rect(x - bw / 2, top - bh, bw, bh, stroke=1, fill=1)
    c.line(x - bw * 0.8, top - bh * 0.9, x + bw * 0.8, top - bh * 0.1)
    c.line(x - bw * 1.05, top - bh * 0.9, x - bw * 0.8, top - bh * 0.9)
    c.line(x, top - bh, x, top - bh - 0.08 * depth)
    c.restoreState()
    sym_earth(c, x, top - bh - 0.08 * depth, 0.36 * depth)


def sym_converter(c, cx, cy, sz, color=INK):
    """DC/AC converter (S00896): square with a diagonal, «=» in one corner and «~» in the other."""
    c.saveState()
    _stroke(c, color, 0.9)
    x0, y0, x1, y1 = cx - sz / 2, cy - sz / 2, cx + sz / 2, cy + sz / 2
    c.setFillColor(colors.white)
    c.rect(x0, y0, sz, sz, stroke=1, fill=1)
    c.line(x0, y0, x1, y1)
    c.setLineWidth(0.7)
    for dy in (0.2, 0.3):
        c.line(x0 + 0.12 * sz, y1 - dy * sz, x0 + 0.4 * sz, y1 - dy * sz)
    tx, ty, w = x1 - 0.42 * sz, y0 + 0.25 * sz, 0.3 * sz
    p = c.beginPath()
    p.moveTo(tx, ty)
    p.curveTo(tx + w * 0.25, ty + w * 0.35, tx + w * 0.25, ty + w * 0.35, tx + w * 0.5, ty)
    p.curveTo(tx + w * 0.75, ty - w * 0.35, tx + w * 0.75, ty - w * 0.35, tx + w, ty)
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()


def sym_pv(c, x, cy, w, h, parallel=1):
    """PV string / array: a row of cells, shown twice when strings run in parallel."""
    c.saveState()
    for p in reversed(range(min(parallel, 2))):
        ox = p * 1.1 * mm
        x0, y0 = x + ox, cy - h / 2 + ox
        _stroke(c, DC_C, 0.8)
        c.setFillColor(LIGHT)
        c.rect(x0, y0, w, h, stroke=1, fill=1)
        n = 4
        c.setLineWidth(0.5)
        for i in range(n):
            cx0 = x0 + i * w / n
            if i:
                c.line(cx0, y0, cx0, y0 + h)
            c.line(cx0 + 0.15 * w / n, y0 + 0.15 * h, cx0 + 0.85 * w / n, y0 + 0.85 * h)
    c.restoreState()


def sym_meter(c, x, cy, w, h):
    """kWh meter, bidirectional: box with «kWh» and a double arrow."""
    c.saveState()
    _stroke(c, INK, 0.9)
    c.setFillColor(colors.white)
    c.rect(x, cy - h / 2, w, h, stroke=1, fill=1)
    _txt(c, x + w / 2, cy + 0.05 * h, "kWh", size=min(5.5, h * 0.42), bold=True, anchor="c")
    ay = cy - 0.25 * h
    c.setLineWidth(0.6)
    c.line(x + 0.2 * w, ay, x + 0.8 * w, ay)
    a = 0.07 * w
    for tip, sgn in ((x + 0.2 * w, 1), (x + 0.8 * w, -1)):
        c.line(tip, ay, tip + sgn * a, ay + a * 0.7)
        c.line(tip, ay, tip + sgn * a, ay - a * 0.7)
    c.restoreState()


def sym_grid(c, cx, cy, r):
    """The public LV network: a supply circle with «~»."""
    c.saveState()
    _stroke(c, INK, 0.9)
    c.setFillColor(colors.white)
    c.circle(cx, cy, r, stroke=1, fill=1)
    w = 1.1 * r
    tx, ty = cx - w / 2, cy
    p = c.beginPath()
    p.moveTo(tx, ty)
    p.curveTo(tx + w * 0.25, ty + w * 0.35, tx + w * 0.25, ty + w * 0.35, tx + w * 0.5, ty)
    p.curveTo(tx + w * 0.75, ty - w * 0.35, tx + w * 0.75, ty - w * 0.35, tx + w, ty)
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()


def sym_battery(c, x, cy, ln, color=DC_C):
    """Battery (S00309): two cells of a long thin and a short thick plate, horizontal from x to x+ln."""
    c.saveState()
    _stroke(c, color, 1.0)
    h = min(0.6 * ln, 4.4 * mm)
    xs = [x + 0.32 * ln, x + 0.44 * ln, x + 0.56 * ln, x + 0.68 * ln]
    c.line(x, cy, xs[0], cy)
    c.line(xs[3], cy, x + ln, cy)
    c.setDash(0.8, 0.8)
    c.setLineWidth(0.5)
    c.line(xs[1], cy, xs[2], cy)
    c.setDash()
    for i, xx in enumerate(xs):
        if i % 2 == 0:
            c.setLineWidth(0.8)
            c.line(xx, cy - h / 2, xx, cy + h / 2)
        else:
            c.setLineWidth(2.0)
            c.line(xx, cy - h / 4, xx, cy + h / 4)
    _txt(c, xs[0] - 0.08 * ln, cy + h / 2 - 1, "+", size=5, anchor="r", color=color)
    _txt(c, xs[3] + 0.08 * ln, cy + h / 2 - 1, "−", size=5, color=color)
    c.restoreState()


def slashes(c, x, y, n, color=INK):
    """Number of conductors: short oblique strokes across the line."""
    c.saveState()
    _stroke(c, color, 0.6)
    for i in range(n):
        xi = x + (i - (n - 1) / 2) * 1.0 * mm
        c.line(xi - 0.6 * mm, y - 1.1 * mm, xi + 0.6 * mm, y + 1.1 * mm)
    c.restoreState()


def _board(c, x0, y0, x1, y1, name):
    """Dashed boundary of a distribution board with its name."""
    c.saveState()
    _stroke(c, BOARD, 0.6)
    c.setDash(4, 2)
    c.rect(x0, y0, x1 - x0, y1 - y0, stroke=1, fill=0)
    c.restoreState()
    _txt(c, x0 + 1.2 * mm, y1 - 2.6 * mm, name, size=5.2, bold=True, color=BOARD, maxw=x1 - x0 - 2 * mm)


def _arrow(c, x1, y, x2):
    c.saveState()
    _stroke(c, INK, 0.7)
    c.line(x1, y, x2, y)
    c.line(x2, y, x2 - 1.2 * mm, y + 0.7 * mm)
    c.line(x2, y, x2 - 1.2 * mm, y - 0.7 * mm)
    c.restoreState()


class _Codes:
    """IEC 81346 style codes, numbered in drawing order: -G1, -W1, -Q1, -F1, -T1, -P1."""

    def __init__(self):
        self.n = {}

    def __call__(self, letter: str) -> str:
        self.n[letter] = self.n.get(letter, 0) + 1
        return f"-{letter}{self.n[letter]}"


# ---------------------------------------------------------------- the page
def _build(project: dict) -> bytes:
    tr, num = report.tr, report.num
    d = (project.get("electrical") or {}).get("design")
    if not d or not d.get("per_inverter"):
        raise ValueError("Κάνε πρώτα τον ηλεκτρολογικό σχεδιασμό (βήμα «Inverter»).")
    v = values(project)
    inv = d["inverter"]
    s = project.get("settings") or {}
    info = project.get("report_info") or {}
    k, phases = v["k"], v["phases"]
    net = tr("1~ 230 V, 50 Hz") if phases == 1 else tr("3~ 400/230 V, 50 Hz")
    scheme = tr(SCHEMES[v["scheme"]])
    code = _Codes()
    bat = battery_report.label(project)
    bf = battery_report.facts(project) if bat else None
    eps = bool(bat) and (v["eps"] if isinstance(v["eps"], bool) else bool(bf and (bf["loads"] or bf["daily_kwh"])))
    eps = eps and v["coupling"] == "dc"

    page_w, page_h = landscape(A4)
    margin = 8 * mm
    band_h = 58 * mm
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    name = project.get("name") or tr("Έργο")
    c.setTitle(f"{tr('Μονογραμμικό ηλεκτρολογικό σχέδιο')} – {name}")
    c.setAuthor(info.get("author") or brand.FULL)
    c.setStrokeColor(INK)
    c.setLineWidth(1.2)
    c.rect(margin, margin, page_w - 2 * margin, page_h - 2 * margin)
    _txt(c, margin + 5 * mm, page_h - margin - 8 * mm,
         tr("ΜΟΝΟΓΡΑΜΜΙΚΟ ΗΛΕΚΤΡΟΛΟΓΙΚΟ ΣΧΕΔΙΟ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ"), size=11.5, bold=True)
    _txt(c, margin + 5 * mm, page_h - margin - 12.5 * mm,
         f"{num(d.get('dc_kwp'), 2)} kWp / {num(d.get('ac_kw'), 2)} kW · {net} · {tr('Σύνδεση')}: {scheme}",
         size=6.5, color=MUTED)
    brand.mark(c, page_w - margin - 6 * mm, page_h - margin - 12 * mm, h=8 * mm, right=True, color=INK)

    # --- geometry of the diagram ---
    L = margin + 5 * mm
    fx = (page_w - margin - 3 * mm - L) / (273 * mm)

    def X(u):
        return L + u * mm * fx

    top_y = page_h - margin - 21 * mm
    y0 = margin + band_h + 6.5 * mm
    eb = 15 * mm
    bb = 25 * mm if bat else 0
    y_pe = y0 + 9 * mm
    y_bat = y0 + eb + 11 * mm
    rows = [(i, j) for i in range(k) for j in range(inv["n_mppt"]) if _mppt_label(d, i, j)[0]]
    inv_used = sorted({i for i, _ in rows})
    rows_bottom = y0 + eb + bb + 3 * mm
    units = len(rows) + 0.35 * (len(inv_used) - 1)
    rh = min(28 * mm, (top_y - 2 * mm - rows_bottom) / max(units, 1))
    gap = 0.35 * rh
    ss = max(0.6, min(1.0, rh / (16 * mm)))
    fs = 5.2 if rh >= 11 * mm else 4.4

    # captions, and the DC ratings once for every row
    _txt(c, X(40), top_y + 3.6 * mm, tr("ΠΛΕΥΡΑ DC (=)"), size=6, bold=True, anchor="c", color=DC_C)
    _txt(c, X(190), top_y + 3.6 * mm, tr("ΠΛΕΥΡΑ AC (~)"), size=6, bold=True, anchor="c")
    dc_rating = f"-Q: {tr('αποζεύκτης φορτίου DC')} ≥ {num(v['vdc'])} V" + (f" / ≥ {num(v['idc'])} A" if v["idc"] else "")
    _txt(c, X(0), top_y + 0.6 * mm,
         f"{dc_rating} · -F: SPD {tr('Τύπος')} {v['spd_dc']} DC, Ucpv ≥ {num(v['vdc'])} V"
         + (f" · gPV {num(v['string_fuse_a'])} A" if v["string_fuse_a"] else ""),
         size=5, color=DC_C, maxw=X(104) - X(0))

    # --- PV strings per MPPT: array, cable, (fuse), DC switch-disconnector, DC SPD ---
    mod_name = s.get("panel_name") or f"{num(s.get('panel_power_w'))} W"
    used_h = (len(rows) + 0.35 * (len(inv_used) - 1)) * rh
    row_y, y = {}, top_y - 2 * mm - max(0.0, (top_y - 2 * mm - rows_bottom - used_h) / 2)
    prev_i = None
    for i, j in rows:
        if prev_i is not None and i != prev_i:
            y -= gap
        prev_i = i
        row_y[(i, j)] = y - rh / 2
        y -= rh
    x_riser = X(-2.5)
    ys_all = list(row_y.values())
    _wire(c, x_riser, max(ys_all), x_riser, y_pe, "pe")
    for (i, j), cy in row_y.items():
        n, label = _mppt_label(d, i, j)
        ah = min(6.5 * mm, rh * 0.3)
        sym_pv(c, X(1), cy, X(26) - X(1), ah, n)
        _wire(c, x_riser, cy, X(1), cy, "pe")
        g = code("G")
        _txt(c, X(1), cy + ah / 2 + (1.2 + (1.1 if n > 1 else 0)) * mm, f"{g} {label}", size=fs, bold=True,
             maxw=X(29) - X(1))
        _txt(c, X(1), cy - ah / 2 - 2.3 * mm,
             f"{mod_name} · MPPT {j + 1}" + (f" · T{i + 1}" if k > 1 else ""), size=fs, color=MUTED,
             maxw=X(29) - X(1))
        x_start = X(28)
        if v["string_fuse_a"]:
            _wire(c, x_start, cy, X(30), cy, "dc")
            sym_fuse(c, X(30), cy, X(36) - X(30), DC_C)
            _txt(c, X(33), cy + 2.2 * mm, code("F"), size=fs, anchor="c", maxw=X(8) - X(0))
            x_start = X(36)
        _wire(c, x_start, cy, X(56), cy, "dc")
        w = code("W")
        _txt(c, X(46), cy + 1.3 * mm, f"{w} {v['dc_cable']}", size=fs, anchor="c", color=DC_C,
             maxw=X(55) - X(37))
        slashes(c, X(49), cy, 2, DC_C)
        _txt(c, X(45), cy - 3.2 * mm, f"{n}×(+/−)" if n > 1 else "+/−", size=fs, anchor="c", color=DC_C)
        sym_switch_disconnector(c, X(56), cy, X(65) - X(56), DC_C)
        _txt(c, X(60.5), cy + 3.8 * mm, code("Q"), size=fs, anchor="c")
        _wire(c, X(65), cy, X(79), cy, "dc")
        depth = min(9 * mm, rh * 0.42)
        sym_spd(c, X(72), cy, depth, DC_C)
        _txt(c, X(70.6) - 0.13 * depth, cy - depth * 0.5, code("F"), size=fs - 0.4, anchor="r")

    # --- inverters ---
    inv_y, inv_box = {}, {}
    for i in inv_used:
        ys = [row_y[r] for r in rows if r[0] == i]
        top, bot = max(ys) + rh * 0.42, min(ys) - rh * 0.42
        x0, x1 = X(79), X(105)
        c.saveState()
        _stroke(c, INK, 1.0)
        c.setFillColor(colors.HexColor("#fffbeb"))
        c.rect(x0, bot, x1 - x0, top - bot, stroke=1, fill=1)
        c.restoreState()
        bh = top - bot
        sz = min(7 * mm, bh * 0.4, (x1 - x0) * 0.4)
        sym_converter(c, (x0 + x1) / 2, top - 1 * mm - sz / 2, sz)
        name_lines = simpleSplit(f"{code('T')} {tr(inv.get('name') or 'Inverter')}", "DejaVu-Bold", fs,
                                 x1 - x0 - 1.5 * mm)
        lines = [(name_lines[0], True)] + [(t, True) for t in name_lines[1:2]] + [
                 (f"{num(inv['pac_w'] / 1000, 1)} kW · {'1~' if phases == 1 else '3~'} · {inv['n_mppt']} MPPT", False),
                 (f"Vdc max {num(inv.get('vdc_max'))} V", False),
                 (f"MPPT {num(inv.get('v_mppt_min'))}–{num(inv.get('v_mppt_max'))} V", False),
                 (f"η {num(inv.get('eff_pct'), 1)} %", False),
                 (f"{tr('Μετασχ. απομόνωσης')}: {v['transformer']}", False),
                 (tr("Αντινησιδοποίηση: ΝΑΙ"), False)]
        yy = top - 1 * mm - sz - 2.2 * mm
        for text, bold in lines:
            if yy < bot + 0.8 * mm:
                break
            _txt(c, (x0 + x1) / 2, yy, text, size=fs, bold=bold, anchor="c", maxw=x1 - x0 - 1.5 * mm)
            yy -= 2.25 * mm
        sym_earth(c, x1 - 2 * mm, bot, 2.6 * mm)
        inv_y[i] = (top + bot) / 2
        inv_box[i] = (x0, bot, x1, top)

    # --- AC: one branch per inverter into the PV board ---
    bus_x = X(153)
    bus_y = (max(inv_y.values()) + min(inv_y.values())) / 2
    poles = v["poles"]
    for n_i, i in enumerate(inv_used):
        cy = inv_y[i]
        first = n_i == 0
        _wire(c, inv_box[i][2], cy, X(125), cy)
        slashes(c, X(109), cy, v["cores"])
        _txt(c, X(109), cy - 3.4 * mm, v["conductors"], size=fs, anchor="c", maxw=X(8) - X(0))
        _txt(c, X(115), cy + 1.3 * mm, f"{code('W')} {v['ac_cable']}", size=4.8, anchor="c", maxw=X(19.5) - X(0))
        sym_breaker(c, X(125), cy, X(134) - X(125))
        q = code("Q")
        _txt(c, X(129.5), cy + 4.0 * mm, f"{q} {poles} {v['curve']}{num(v['brk'])} {num(v['icu'])} kA" if first else q,
             size=fs, anchor="c", maxw=X(18) - X(0))
        _wire(c, X(134), cy, X(137), cy)
        sym_rcd(c, X(137), cy, X(148) - X(137))
        f = code("F")
        if first:
            _txt(c, X(142.5), cy - 3.4 * mm, f"{f} {poles} {num(v['brk'])} A", size=fs, anchor="c",
                 maxw=X(16) - X(0))
            _txt(c, X(142.5), cy - 5.7 * mm, f"IΔn {num(v['rcd_ma'])} mA · {tr('Τύπος')} {v['rcd_type']}", size=fs,
                 bold=True, anchor="c", maxw=X(17) - X(0))
        else:
            _txt(c, X(142.5), cy - 3.4 * mm, f, size=fs, anchor="c")
        _wire(c, X(148), cy, bus_x, cy)

    # --- battery (DC-coupled to the hybrid inverter, or AC-coupled with its own converter) ---
    bus_lo = min(inv_y.values())
    eps_box = None
    if bat:
        hyb = inv_used[-1]
        hx0, hbot, hx1, _ = inv_box[hyb]
        bw = X(24) - X(4)
        sym_battery(c, X(4), y_bat, bw)
        _txt(c, X(14), y_bat + 4.6 * mm, f"{code('G')} {bat}", size=5.2, bold=True, anchor="c", maxw=X(30) - X(0))
        _txt(c, X(14), y_bat - 5.6 * mm, f"{battery_report._kw(bf['power_kw'])} · BMS", size=5.2, anchor="c",
             maxw=X(28) - X(0))
        _wire(c, X(24), y_bat, X(30), y_bat, "dc")
        sym_fuse(c, X(30), y_bat, X(36) - X(30), DC_C)
        _txt(c, X(29), y_bat + 2.2 * mm, f"{code('F')} {tr('ασφάλεια/αυτόματος DC')} {BLANK} A", size=fs,
             maxw=X(26) - X(0))
        _wire(c, X(36), y_bat, X(56), y_bat, "dc")
        sym_switch_disconnector(c, X(56), y_bat, X(65) - X(56), DC_C)
        _txt(c, X(56), y_bat + 4.2 * mm, f"{code('Q')} {tr('αποζεύκτης μπαταρίας')}", size=fs, maxw=X(23) - X(0))
        if v["coupling"] == "dc":
            xin = hx0 + 4 * mm
            _wire(c, X(65), y_bat, xin, y_bat, "dc")
            _wire(c, xin, y_bat, xin, hbot, "dc")
            _txt(c, xin - 0.8 * mm, hbot - 2.6 * mm, "BAT", size=4.4, anchor="r", color=DC_C)
            _wire(c, X(22), y_bat - 3 * mm, xin + 3 * mm, y_bat - 3 * mm, "com")
            _wire(c, xin + 3 * mm, y_bat - 3 * mm, xin + 3 * mm, hbot, "com")
            _txt(c, X(45), y_bat - 5.4 * mm, tr("BMS – CAN/RS485"), size=fs, anchor="c", color=MUTED)
            if eps:
                xe = hx1 - 6 * mm
                ye = y_bat - 2 * mm
                _wire(c, xe, hbot, xe, ye)
                _txt(c, xe + 0.8 * mm, hbot - 2.6 * mm, "EPS", size=4.4)
                _wire(c, xe, ye, X(125), ye)
                sym_breaker(c, X(125), ye, X(134) - X(125))
                _txt(c, X(129.5), ye + 4.0 * mm, f"{code('Q')} {poles} {v['curve']}{BLANK} A", size=fs, anchor="c",
                     maxw=X(18) - X(0))
                _wire(c, X(134), ye, X(137), ye)
                sym_rcd(c, X(137), ye, X(148) - X(137))
                _txt(c, X(142.5), ye - 3.4 * mm, f"{code('F')} IΔn {num(v['rcd_ma'])} mA", size=fs, anchor="c",
                     maxw=X(18) - X(0))
                _arrow(c, X(148), ye, X(156))
                _txt(c, X(157), ye - 0.8 * mm, tr("εφεδρικά φορτία"), size=fs, maxw=X(16) - X(0))
                eps_box = (ye - 7.5 * mm, ye + 10.5 * mm)
        else:
            sz = min(9 * mm, bb * 0.5)
            cxb = (X(79) + X(105)) / 2
            _wire(c, X(65), y_bat, cxb - sz / 2, y_bat, "dc")
            sym_converter(c, cxb, y_bat, sz)
            _txt(c, cxb, y_bat + sz / 2 + 1.2 * mm, f"{code('T')} {tr('Inverter μπαταρίας')}", size=fs, bold=True,
                 anchor="c", maxw=X(30) - X(0))
            _wire(c, X(22), y_bat - 3 * mm, cxb, y_bat - 3 * mm, "com")
            _txt(c, X(45), y_bat - 5.4 * mm, tr("BMS – CAN/RS485"), size=fs, anchor="c", color=MUTED)
            _wire(c, cxb + sz / 2, y_bat, X(125), y_bat)
            slashes(c, X(110), y_bat, v["cores"])
            sym_breaker(c, X(125), y_bat, X(134) - X(125))
            _txt(c, X(129.5), y_bat + 4.0 * mm, f"{code('Q')} {poles} {v['curve']}{BLANK} A", size=fs, anchor="c",
                 maxw=X(18) - X(0))
            _wire(c, X(134), y_bat, X(137), y_bat)
            sym_rcd(c, X(137), y_bat, X(148) - X(137))
            _txt(c, X(142.5), y_bat - 3.4 * mm, f"{code('F')} IΔn {num(v['rcd_ma'])} mA", size=fs, anchor="c",
                 maxw=X(18) - X(0))
            _wire(c, X(148), y_bat, bus_x, y_bat)
            bus_lo = y_bat

    # PV board bus, AC SPD and AC isolator
    c.saveState()
    _stroke(c, INK, 2.2)
    c.line(bus_x, min(bus_lo, bus_y) - 1.5 * mm, bus_x, max(max(inv_y.values()), bus_y) + 1.5 * mm)
    c.restoreState()
    _wire(c, bus_x, bus_y, X(161), bus_y)
    sym_spd(c, X(157), bus_y, 8 * mm)
    _txt(c, X(158.6), bus_y - 3.6 * mm, f"{code('F')} SPD {tr('Τύπος')} {v['spd_ac']} AC", size=fs,
         maxw=X(14) - X(0))
    _txt(c, X(158.6), bus_y - 5.9 * mm, "Uc ≥ 275 V", size=fs, maxw=X(14) - X(0))
    sym_switch_disconnector(c, X(161), bus_y, X(170) - X(161))
    iso = breaker_for(v["main_brk"])
    _txt(c, X(165.5), bus_y + 6.4 * mm, tr("αποζεύκτης AC ΦΒ"), size=fs, anchor="c", maxw=X(16) - X(0))
    _txt(c, X(165.5), bus_y + 4.0 * mm, f"{code('Q')} {poles} ≥ {num(iso)} A", size=fs, anchor="c",
         maxw=X(16) - X(0))
    pv_top = max(max(inv_y.values()), bus_y) + 10 * mm
    pv_bot = min(bus_lo - 6.5 * mm, bus_y - 12 * mm)
    _board(c, X(119), pv_bot, X(174), pv_top, tr("Πίνακας ΦΒ (AC)"))
    if eps_box:
        _board(c, X(119), eps_box[0], X(174), min(eps_box[1], pv_bot - 1.5 * mm), tr("Πίνακας εφεδρείας (EPS/backup)"))

    # PV board → main board
    _wire(c, X(170), bus_y, X(187), bus_y)
    ac_type, ac_size = v["ac_cable_type"], v["ac_cable_size"]
    _txt(c, X(180), bus_y + 1.3 * mm, f"{code('W')} {ac_type}", size=fs, anchor="c", maxw=X(12) - X(0))
    slashes(c, X(180), bus_y, v["cores"])
    _txt(c, X(180), bus_y - 3.6 * mm, ac_size, size=fs, anchor="c", maxw=X(12) - X(0))
    _txt(c, X(180), bus_y - 5.9 * mm, v["conductors"], size=fs, anchor="c", maxw=X(10) - X(0))

    # main board
    sym_breaker(c, X(187), bus_y, X(196) - X(187))
    _txt(c, X(191.5), bus_y + 4.0 * mm, f"{code('Q')} {poles} {v['curve']}{num(v['main_brk'])}", size=fs, anchor="c",
         maxw=X(12) - X(0))
    _wire(c, X(196), bus_y, X(205), bus_y)
    gp_x = X(200)
    c.saveState()
    _stroke(c, INK, 2.2)
    c.line(gp_x, bus_y - 6 * mm, gp_x, bus_y + 7 * mm)
    c.restoreState()
    _arrow(c, gp_x, bus_y - 5 * mm, gp_x + 4.5 * mm)
    _txt(c, gp_x + 5.2 * mm, bus_y - 5.6 * mm, tr("καταναλώσεις"), size=fs, maxw=X(14.5) - X(0))
    sym_breaker(c, X(205), bus_y, X(214) - X(205))
    _txt(c, X(209.5), bus_y + 6.4 * mm, f"{code('Q')} {tr('Γενικός')}", size=fs, anchor="c", maxw=X(17) - X(0))
    _txt(c, X(209.5), bus_y + 4.0 * mm, f"{poles} {BLANK} A", size=fs, anchor="c", maxw=X(17) - X(0))
    gp_bot = bus_y - 8.5 * mm
    _board(c, X(183.5), gp_bot, X(220), bus_y + 13 * mm, tr("Γενικός πίνακας (Γ.Π.)"))

    # main board → meter, meter, service fuse, grid
    _wire(c, X(214), bus_y, X(232), bus_y)
    _txt(c, X(222), bus_y + 1.3 * mm, f"{code('W')} {v['meter_cable']} mm²", size=fs, anchor="c",
         maxw=X(15) - X(0))
    slashes(c, X(219), bus_y, v["cores"])
    _txt(c, X(219), bus_y - 3.6 * mm, v["conductors"], size=fs, anchor="c", maxw=X(9) - X(0))
    if bat:
        c.saveState()
        _stroke(c, INK, 0.6)
        c.circle(X(228), bus_y, 1.2 * mm, stroke=1, fill=0)
        c.restoreState()
        _txt(c, X(228), bus_y - 3.6 * mm, "CT", size=fs, anchor="c")
        _wire(c, X(228), bus_y - 4.6 * mm, X(228), bus_y - 8 * mm, "com")
        _txt(c, X(228), bus_y - 10.4 * mm, f"smart meter → T{hyb + 1 if v['coupling'] == 'dc' else k + 1}",
             size=fs - 0.3, anchor="c", color=MUTED, maxw=X(20) - X(0))
    sym_meter(c, X(232), bus_y, X(244) - X(232), 8 * mm)
    _txt(c, X(238), bus_y + 8.4 * mm, f"{code('P')} {tr('Μετρητής ΔΕΔΔΗΕ')}", size=fs, bold=True, anchor="c",
         maxw=X(24) - X(0))
    _txt(c, X(238), bus_y + 5.6 * mm, f"{tr('αμφίδρομος')} · {scheme}", size=fs, anchor="c", maxw=X(22) - X(0))
    _wire(c, X(244), bus_y, X(248), bus_y)
    sym_fuse(c, X(248), bus_y, X(254) - X(248))
    _txt(c, X(251), bus_y - 3.6 * mm, tr("ασφ. παροχής"), size=fs, anchor="c", maxw=X(13) - X(0))
    _txt(c, X(251), bus_y - 5.9 * mm, f"{BLANK} A", size=fs, anchor="c")
    _wire(c, X(254), bus_y, X(266) - 3.5 * mm, bus_y)
    sym_grid(c, X(266), bus_y, 3.5 * mm)
    right = page_w - margin - 2 * mm
    _txt(c, right, bus_y + 9.4 * mm, tr("Δίκτυο ΧΤ ΔΕΔΔΗΕ"), size=fs, bold=True, anchor="r", maxw=X(22) - X(0))
    _txt(c, right, bus_y + 6.6 * mm, net, size=fs, anchor="r", maxw=X(22) - X(0))

    # --- earthing ---
    _wire(c, x_riser, y_pe, gp_x - 5 * mm, y_pe, "pe")
    c.saveState()
    _stroke(c, PE_C, 2.4)
    c.line(gp_x - 5 * mm, y_pe, gp_x + 5 * mm, y_pe)
    c.restoreState()
    _wire(c, gp_x, gp_bot, gp_x, y_pe, "pe")
    sym_earth(c, gp_x, y_pe, 4 * mm)
    _txt(c, X(2), y_pe + 1.2 * mm,
         f"PE: {tr('ισοδυναμική σύνδεση πλαισίων/βάσεων ΦΒ, inverter, SPD και πινάκων στον ΚΖΓ')} – Cu {v['pe_cable']} mm²",
         size=fs, color=PE_C, maxw=gp_x - 6 * mm - X(2))
    tx = gp_x + 6.5 * mm
    for n_l, text in enumerate([
            f"{tr('ΚΖΓ – κύριος ζυγός γείωσης')} · {tr('ηλεκτρόδιο')}: {v['earthing']}",
            f"{tr('Σύστημα γείωσης περιοχής (TN-C-S / TT)')}: {v['earthing_system']}",
            f"{tr('Σύνδεση με αλεξικέραυνο (LPS), αν υπάρχει')}: {BLANK}"]):
        _txt(c, tx, y_pe + 0.8 * mm - n_l * 2.6 * mm, text, size=fs, color=PE_C, maxw=right - tx)

    # --- disclaimer and bottom band ---
    c.setFont("DejaVu", 6.2)
    c.setFillColor(RED)
    c.drawString(margin + 3 * mm, margin + band_h + 2.2 * mm,
                 tr("Ενδεικτικό σχέδιο: οι προστασίες και οι διατομές καλωδίων πρέπει να ελεγχθούν και να υπογραφούν "
                    "από τον υπεύθυνο μηχανικό/ηλεκτρολόγο."))
    by0, by1 = margin, margin + band_h
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.line(margin, by1, page_w - margin, by1)
    xs = [margin, margin + 86 * mm, margin + 150 * mm, margin + 213 * mm, page_w - margin]
    for xx in xs[1:-1]:
        c.line(xx, by0, xx, by1)
    _legend(c, xs[0] + 2.5 * mm, by1 - 4.5 * mm, xs[1] - xs[0] - 4 * mm, bool(bat))
    _protection_table(c, xs[1] + 2.5 * mm, by1 - 4.5 * mm, xs[2] - xs[1] - 5 * mm)
    _notes(c, xs[2] + 2.5 * mm, by1 - 4.5 * mm, xs[3] - xs[2] - 5 * mm, by0 + 2 * mm, v, bat, eps)
    _title_block(c, xs[3], by0, xs[4], by1, project, d, info)
    c.showPage()
    c.save()
    return buf.getvalue()


def _legend(c, x, y, w, battery: bool):
    tr = report.tr
    _txt(c, x, y, tr("Υπόμνημα συμβόλων"), size=6.2, bold=True)
    s = 7 * mm
    items = [
        (lambda xx, yy: sym_pv(c, xx, yy, s, 2.6 * mm), tr("ΦΒ string / συστοιχία (G)")),
        (lambda xx, yy: sym_fuse(c, xx, yy, s), tr("Ασφάλεια (F)")),
        (lambda xx, yy: sym_switch_disconnector(c, xx, yy, s), tr("Διακόπτης-αποζεύκτης φορτίου (Q)")),
        (lambda xx, yy: sym_breaker(c, xx, yy, s), tr("Αυτόματος διακόπτης (Q)")),
        (lambda xx, yy: sym_rcd(c, xx, yy, s), tr("Διακόπτης διαφυγής RCD (F)")),
        (lambda xx, yy: (_wire(c, xx, yy + 1.2 * mm, xx + s, yy + 1.2 * mm), sym_spd(c, xx + s / 2, yy + 1.2 * mm, 4.6 * mm)),
         tr("Απαγωγός υπερτάσεων SPD (F)")),
        (lambda xx, yy: sym_converter(c, xx + s / 2, yy, 4.6 * mm), tr("Inverter DC/AC (T)")),
        (lambda xx, yy: sym_meter(c, xx + 0.5 * mm, yy, s - 1 * mm, 4.4 * mm), tr("Μετρητής kWh αμφίδρομος (P)")),
        (lambda xx, yy: sym_grid(c, xx + s / 2, yy, 2.2 * mm), tr("Δίκτυο ΔΕΔΔΗΕ")),
        (lambda xx, yy: sym_earth(c, xx + s / 2, yy + 1.5 * mm, 3.6 * mm), tr("Γείωση / ΚΖΓ")),
        (lambda xx, yy: (_wire(c, xx, yy, xx + s, yy), slashes(c, xx + s / 2, yy, 5)), tr("Πλήθος αγωγών (π.χ. 3/N/PE)")),
        (lambda xx, yy: _wire(c, xx, yy, xx + s, yy, "dc"), tr("Γραμμή DC")),
        (lambda xx, yy: _wire(c, xx, yy, xx + s, yy, "ac"), tr("Γραμμή AC")),
        (lambda xx, yy: _wire(c, xx, yy, xx + s, yy, "pe"), tr("Αγωγός γείωσης PE / ισοδυναμικός")),
        (lambda xx, yy: _board_mini(c, xx, yy, s), tr("Όριο πίνακα")),
        (None, tr("W: καλώδιο · κωδικοί κατά IEC 81346")),
    ]
    if battery:
        items[10:10] = [(lambda xx, yy: sym_battery(c, xx, yy, s), tr("Μπαταρία (G)")),
                        (lambda xx, yy: _wire(c, xx, yy, xx + s, yy, "com"), tr("Επικοινωνία (RS485/CAN)"))]
    per_col = math.ceil(len(items) / 2)
    pitch = min(5.6 * mm, (y - 3 * mm - (y - 52 * mm)) / per_col)
    col_w = w / 2
    for n, (draw, text) in enumerate(items):
        cx = x + (n // per_col) * col_w
        cy = y - 5 * mm - (n % per_col) * pitch
        if draw:
            draw(cx, cy)
            _txt(c, cx + s + 1.8 * mm, cy - 1.6, text, size=5, maxw=col_w - s - 2.5 * mm)
        else:
            _txt(c, cx, cy - 1.6, text, size=5, maxw=col_w - 1 * mm)


def _board_mini(c, x, y, s):
    c.saveState()
    _stroke(c, BOARD, 0.6)
    c.setDash(2, 1)
    c.rect(x, y - 1.6 * mm, s, 3.2 * mm, stroke=1, fill=0)
    c.restoreState()


def _protection_table(c, x, y, w):
    tr, num = report.tr, report.num
    _txt(c, x, y, tr("Ρυθμίσεις προστασίας διασύνδεσης"), size=6.2, bold=True, maxw=w)
    yy = y - 2.8 * mm
    for line in simpleSplit(tr("Ενδεικτικά – σύμφωνα με τον ΔΕΔΔΗΕ/ρυθμίσεις inverter· να επιβεβαιωθούν."),
                            "DejaVu", 5, w):
        _txt(c, x, yy, line, size=5, color=RED)
        yy -= 2.3 * mm
    yy -= 1 * mm
    cols = [x, x + 0.42 * w, x + 0.8 * w]
    rows = [
        (tr("Προστασία"), tr("Όριο"), tr("Χρόνος")),
        (tr("U> υπέρταση"), f"{num(264.5, 1)} V (+15 %)", f"{num(0.5, 1)} s"),
        (tr("U< υπόταση"), f"{num(184)} V (−20 %)", f"{num(0.5, 1)} s"),
        (tr("f> υπερσυχνότητα"), f"{num(50.5, 1)} Hz", f"{num(0.5, 1)} s"),
        (tr("f< υποσυχνότητα"), f"{num(49.5, 1)} Hz", f"{num(0.5, 1)} s"),
        (tr("Επανασύνδεση"), tr("U, f εντός ορίων"), "3 min"),
    ]
    c.setStrokeColor(MUTED)
    c.setLineWidth(0.4)
    for n, row in enumerate(rows):
        for cx, cell in zip(cols, row):
            _txt(c, cx + 0.6 * mm, yy, cell, size=5.1, bold=n == 0, maxw=(cols[1] - cols[0]) - 1 * mm)
        c.setStrokeColor(MUTED)
        c.setLineWidth(0.4)
        c.line(x, yy - 1.1 * mm, x + w, yy - 1.1 * mm)
        yy -= 3.3 * mm
    yy -= 0.6 * mm
    for text in (tr("Un = 230 V (φασική), fn = 50 Hz"),
                 tr("Αντινησιδοποίηση: ΝΑΙ, κατά VDE 0126-1-1 / EN 50549-1"),
                 tr("Οι ρυθμίσεις δεν αλλάζουν χωρίς τη σύμφωνη γνώμη του ΔΕΔΔΗΕ.")):
        for line in simpleSplit(text, "DejaVu", 5, w):
            _txt(c, x, yy, line, size=5)
            yy -= 2.3 * mm


def _notes(c, x, y, w, y_min, v, bat, eps):
    tr, num = report.tr, report.num
    notes = [
        (tr("Σήμανση «ΠΡΟΣΟΧΗ – διπλή τροφοδοσία (δίκτυο και ΦΒ)» στο σημείο σύνδεσης, στον Γ.Π. και στον μετρητή."), INK),
        (tr("Σήμανση «Ενεργά μέρη ΦΒ: υπό τάση DC και μετά την απόζευξη» σε κουτιά, αποζεύκτες και καλώδια DC."), INK),
        (tr("Απομόνωση έκτακτης ανάγκης: άνοιγμα του αποζεύκτη AC ΦΒ, μετά των αποζευκτών DC") +
         (tr(" και του αποζεύκτη μπαταρίας") if bat else "") + ".", INK),
        ((tr("Ασφάλειες string: gPV {a} A / {v} V DC.").format(a=num(v["string_fuse_a"]), v=num(v["vdc"]))
          if v["string_fuse_a"] else
          tr("Ασφάλειες string: όχι, εκτός αν απαιτούνται (EN 62548: ρεύμα επιστροφής από ≥ 3 παράλληλα strings).")),
         INK),
        (tr("RCD: Τύπου B ή inverter με RCMU (Τύπος A μόνο με δήλωση του κατασκευαστή)."), INK),
        (tr("Ενδεικτικές τιμές (καμπύλη C, 6 kA, H1Z2Z2-K 1×6 mm², SPD Τύπου 2· Τύπου 1+2 αν υπάρχει αλεξικέραυνο "
            "χωρίς απόσταση ασφαλείας): η τελική επιλογή και οι διατομές «……» από τον ηλεκτρολόγο."), INK),
        (tr("Γραμμή Γ.Π.–μετρητή: η διατομή της και η επιλογικότητα του γενικού διακόπτη με την ασφάλεια του "
            "μετρητή ελέγχονται από τον ΔΕΔΔΗΕ."), INK),
    ]
    if bat:
        notes.append(((tr("Μπαταρία: σύζευξη DC (υβριδικός inverter)") if v["coupling"] == "dc"
                       else tr("Μπαταρία: σύζευξη AC (ξεχωριστός inverter μπαταρίας)"))
                      + ("" if v["coupling_known"] else tr(" – προεπιλογή, να επιβεβαιωθεί"))
                      + ". " + tr("Σήμανση «Σύστημα αποθήκευσης – τάση DC …… V» και «πολλαπλές πηγές τροφοδοσίας»."),
                      INK))
        if eps:
            notes.append((tr("EPS/backup: συνέχεια ουδετέρου και λειτουργία RCD σε νησίδα κατά τον κατασκευαστή."),
                          INK))
    if v["single_phase_over_5kw"]:
        notes.append((tr("ΠΡΟΣΟΧΗ: μονοφασική σύνδεση πάνω από 5 kW. Κατά το πληροφοριακό δελτίο του ΔΕΔΔΗΕ η "
                         "μονοφασική σύνδεση επιτρέπεται έως 5 kW· πάνω από αυτό απαιτείται τριφασική. "
                         "Να επιβεβαιωθεί με τον ΔΕΔΔΗΕ."), RED))
    _txt(c, x, y, tr("Σημειώσεις"), size=6.2, bold=True)
    for size in (5.0, 4.6, 4.2, 3.8, 3.5):
        lead = size * 1.25
        wrapped = [(n, line, col) for n, (text, col) in enumerate(notes, 1)
                   for line in simpleSplit(f"{n}. {text}", "DejaVu", size, w)]
        if y - 3.2 * mm - len(wrapped) * lead - len(notes) * 0.5 >= y_min or size == 3.5:
            break
    yy = y - 3.2 * mm
    last = None
    for n, line, col in wrapped:
        if last is not None and n != last:
            yy -= 0.5
        _txt(c, x, yy, line, size=size, color=col)
        yy -= lead
        last = n


def _title_block(c, x0, y0, x1, y1, project, d, info):
    tr, num = report.tr, report.num
    x = x0 + 2.5 * mm
    w = x1 - x0 - 5 * mm
    _txt(c, x, y1 - 4.5 * mm, tr("Μονογραμμικό σχέδιο ΦΒ"), size=6.4, bold=True, maxw=w * 0.6)
    _txt(c, x1 - 2.5 * mm, y1 - 4.5 * mm, tr("Σελίδα {page} από {total}").format(page=1, total=1), size=6,
         anchor="r")
    rows = [
        (tr("Έργο"), project.get("name") or "–"),
        (tr("Πελάτης"), info.get("client") or "–"),
        (tr("Διεύθυνση"), info.get("address") or "–"),
        (tr("Αριθμός Παροχής"), info.get("supply_no") or BLANK),
        (tr("Ισχύς DC / AC"), f"{num(d.get('dc_kwp'), 2)} kWp / {num(d.get('ac_kw'), 2)} kW"),
        (tr("Αριθμός πάνελ"), f"{num(d.get('modules_used'))} ({d.get('n_strings')} strings)"),
        (tr("Συντάκτης"), info.get("author") or "–"),
        (tr("Ημερομηνία"), date.today().strftime("%d/%m/%Y")),
        (tr("Κλίμακα"), tr("Χωρίς κλίμακα")),
    ]
    yy = y1 - 8.3 * mm
    for label, value in rows:
        _txt(c, x, yy, label, size=5.2, color=MUTED, maxw=21 * mm)
        _txt(c, x + 22 * mm, yy, str(value)[:60], size=5.8, bold=True, maxw=w - 22 * mm)
        yy -= 2.85 * mm
    # «as built» box
    c.setStrokeColor(INK)
    c.setLineWidth(0.6)
    c.rect(x, yy - 0.6 * mm, 2.4 * mm, 2.4 * mm, stroke=1, fill=0)
    _txt(c, x + 3.4 * mm, yy, tr("Όπως κατασκευάστηκε"), size=5.4, bold=True)
    _txt(c, x1 - 2.5 * mm, yy, f"{tr('Αρ. σχεδίου / αναθ.')}: {BLANK}", size=5.2, anchor="r")
    # signature boxes
    sb_top = yy - 2.6 * mm
    sb_h = sb_top - y0 - 2 * mm
    half = (w - 2 * mm) / 2
    for n, text in enumerate((tr("Ο ηλεκτρολόγος εγκαταστάτης (σφραγίδα, υπογραφή, αρ. άδειας)"),
                              tr("Ο ιδιοκτήτης / χρήστης (υπογραφή)"))):
        bx = x + n * (half + 2 * mm)
        c.setStrokeColor(MUTED)
        c.setLineWidth(0.5)
        c.rect(bx, y0 + 2 * mm, half, sb_h, stroke=1, fill=0)
        ly = sb_top - 2.4 * mm
        for line in simpleSplit(text, "DejaVu", 4.8, half - 1.5 * mm):
            _txt(c, bx + 0.8 * mm, ly, line, size=4.8, color=MUTED)
            ly -= 2.1 * mm


def filename(project: dict, lang: str = "el") -> str:
    base = report.filename(project, lang)[:-4]
    return i18n.tr("Μονογραμμικό ΦΒ - {name}.pdf", lang).format(name=base.split(" - ", 1)[-1])
