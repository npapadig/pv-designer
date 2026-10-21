"""Client-ready PDF report of a project, in Greek.

The report is a cover page followed by sections. Each section is a function
registered with @section(order); it gets a ReportContext and returns a list of
reportlab flowables, or None to leave itself out (e.g. when its data is missing).

Adding a section for a new feature (shading, electrical design, finances, ...)
takes one of two routes:

1. Write a section function here (or in a module imported by main.py):

       @section(65)
       def my_section(ctx):
           data = ctx.project.get("my_feature")
           if not data:
               return None
           return [ctx.heading("Τίτλος"), ctx.kv_table([("Πεδίο", "τιμή")])]

2. Or store a ready-made "report" block in the project under one of the keys
   in PLUGIN_SECTIONS (e.g. project["finance"]["report"]), shaped like:

       {"summary": [["Κόστος", "8.500 €"], ...],              # label/value rows
        "tables": [{"title": "...", "columns": [...], "rows": [[...], ...]}],
        "notes": ["κείμενο", ...]}

   and it is printed automatically under that section's title.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    BaseDocTemplate, CondPageBreak, Frame, Image, NextPageTemplate, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

from . import mapimage

FONT_DIR = Path(__file__).resolve().parent / "fonts"
pdfmetrics.registerFont(TTFont("DejaVu", str(FONT_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold")

ACCENT = colors.HexColor("#f59e0b")
ACCENT_DARK = colors.HexColor("#b45309")
TEXT = colors.HexColor("#1d2330")
MUTED = colors.HexColor("#667085")
LIGHT = colors.HexColor("#f6f7f9")
BORDER = colors.HexColor("#dde1e7")
LOSS = colors.HexColor("#fca5a5")
GOOD = colors.HexColor("#16a34a")

PAGE_W, PAGE_H = A4
MARGIN = 1.8 * cm
CONTENT_W = PAGE_W - 2 * MARGIN

MONTHS = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος",
          "Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"]
MONTHS_SHORT = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"]
MOUNTING = {"flush": "Παράλληλα με κεκλιμένη στέγη", "rack": "Σε βάσεις (ταράτσα / έδαφος)"}
ORIENTATION = {"portrait": "Κατακόρυφα", "landscape": "Οριζόντια"}

# Optional sections filled from project[key]["report"] blocks (see module docstring).
PLUGIN_SECTIONS = [
    (50, "shading", "Ανάλυση σκιάσεων"),
    (60, "electrical", "Ηλεκτρολογικός σχεδιασμός"),
    (70, "finance", "Οικονομική ανάλυση"),
]


def num(v, d: int = 0) -> str:
    """Greek number format: 12.345,6"""
    if v is None:
        return "–"
    s = f"{float(v):,.{d}f}"
    return s.replace(",", "§").replace(".", ",").replace("§", ".")


def compass(az: float) -> str:
    names = ["Βόρειος", "Βορειοανατολικός", "Ανατολικός", "Νοτιοανατολικός",
             "Νότιος", "Νοτιοδυτικός", "Δυτικός", "Βορειοδυτικός"]
    return names[int(((az % 360) + 22.5) // 45) % 8]


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("base", fontName="DejaVu", fontSize=9.5, leading=13.5, textColor=TEXT)
    return {
        "body": base,
        "small": ParagraphStyle("small", base, fontSize=8, leading=11, textColor=MUTED),
        "h1": ParagraphStyle("h1", base, fontName="DejaVu-Bold", fontSize=16, leading=20,
                             textColor=ACCENT_DARK, spaceBefore=14, spaceAfter=10),
        "h2": ParagraphStyle("h2", base, fontName="DejaVu-Bold", fontSize=11, leading=15,
                             spaceBefore=10, spaceAfter=6),
        "cell": ParagraphStyle("cell", base, fontSize=9, leading=12),
        "kpi_value": ParagraphStyle("kpi_v", base, fontName="DejaVu-Bold", fontSize=17, leading=21,
                                    alignment=TA_CENTER),
        "kpi_label": ParagraphStyle("kpi_l", base, fontSize=8, leading=10, textColor=MUTED, alignment=TA_CENTER),
        "cover_kicker": ParagraphStyle("ck", base, fontName="DejaVu-Bold", fontSize=10, textColor=ACCENT_DARK),
        "cover_title": ParagraphStyle("ct", base, fontName="DejaVu-Bold", fontSize=26, leading=32,
                                      spaceBefore=6, spaceAfter=6),
        "cover_sub": ParagraphStyle("cs", base, fontSize=12, leading=16, textColor=MUTED),
    }


def _esc(s) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


@dataclass
class ReportContext:
    project: dict
    imagery: bool = True
    styles: dict = field(default_factory=_styles)
    _map: tuple | None = None

    # --- project data ---
    @property
    def settings(self) -> dict:
        return self.project.get("settings") or {}

    @property
    def layout(self) -> dict:
        return self.project.get("layout") or {}

    @property
    def energy(self) -> dict:
        return self.project.get("energy") or {}

    @property
    def info(self) -> dict:
        return self.project.get("report_info") or {}

    def map_image(self) -> tuple[bytes, bool] | None:
        """(JPEG, has satellite imagery) of the layout, rendered once; None if nothing is drawn."""
        if self._map is None:
            areas = self.project.get("areas") or []
            panels = self.layout.get("panels") or []
            try:
                self._map = mapimage.render_layout(
                    areas, self.project.get("keepouts") or [], panels, imagery=self.imagery)
            except ValueError:
                self._map = ()
        return self._map or None

    # --- building blocks for sections ---
    def heading(self, text: str) -> Paragraph:
        return Paragraph(_esc(text), self.styles["h1"])

    def subheading(self, text: str) -> Paragraph:
        return Paragraph(_esc(text), self.styles["h2"])

    def para(self, text: str, style: str = "body") -> Paragraph:
        return Paragraph(text, self.styles[style])

    def kv_table(self, rows, col1: float = 0.45) -> Table:
        data = [[Paragraph(_esc(k), self.styles["cell"]), Paragraph(f"<b>{_esc(v)}</b>", self.styles["cell"])]
                for k, v in rows]
        t = Table(data, colWidths=[CONTENT_W * col1, CONTENT_W * (1 - col1)])
        t.setStyle(TableStyle([
            ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, LIGHT]),
            ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        return t

    def data_table(self, columns, rows, widths=None, total_row: bool = False) -> Table:
        head = [Paragraph(f"<b>{_esc(c)}</b>", self.styles["cell"]) for c in columns]
        body = [[Paragraph(_esc(v), self.styles["cell"]) for v in r] for r in rows]
        if total_row and body:
            body[-1] = [Paragraph(f"<b>{_esc(v)}</b>", self.styles["cell"]) for v in rows[-1]]
        if widths is None:
            widths = [CONTENT_W / len(columns)] * len(columns)
        t = Table([head] + body, colWidths=widths, repeatRows=1)
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, ACCENT),
            ("LINEBELOW", (0, 1), (-1, -1), 0.4, BORDER),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
        if total_row:
            style.append(("LINEABOVE", (0, -1), (-1, -1), 0.8, TEXT))
        t.setStyle(TableStyle(style))
        return t

    def kpis(self, items) -> Table:
        """A row of headline numbers: [(value, label), ...]"""
        cells = [[Paragraph(_esc(v), self.styles["kpi_value"]), Paragraph(_esc(l), self.styles["kpi_label"])]
                 for v, l in items]
        w = CONTENT_W / len(items)
        t = Table([[Table([[c[0]], [c[1]]], colWidths=[w - 8]) for c in cells]], colWidths=[w] * len(items))
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), LIGHT),
            ("LINEABOVE", (0, 0), (-1, 0), 2, ACCENT),
            ("LINEAFTER", (0, 0), (-2, -1), 3, colors.white),
            ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        return t

    def block(self, data: dict) -> list:
        """Render a plugin "report" block (summary / tables / notes)."""
        out = []
        if data.get("summary"):
            out.append(self.kv_table(data["summary"]))
        for tbl in data.get("tables") or []:
            if tbl.get("title"):
                out.append(self.subheading(tbl["title"]))
            out.append(self.data_table(tbl.get("columns") or [], tbl.get("rows") or []))
        for note in data.get("notes") or []:
            out += [Spacer(1, 4), self.para(_esc(note), "small")]
        return out

    # --- derived numbers ---
    def kwp(self) -> float:
        return float(self.layout.get("kwp") or 0)

    def performance_ratio(self) -> float | None:
        e = self.energy
        h = e.get("annual_irradiation") or 0
        if not (h and self.kwp() and e.get("annual_kwh")):
            return None
        return e["annual_kwh"] / (h * self.kwp())


SECTIONS: list[tuple[int, Callable[[ReportContext], list | None]]] = []


def section(order: int):
    """Register a report section; lower order comes first."""
    def wrap(fn):
        SECTIONS.append((order, fn))
        SECTIONS.sort(key=lambda s: s[0])
        return fn
    return wrap


def headline_kpis(ctx: ReportContext) -> list[tuple[str, str]]:
    e = ctx.energy
    pr = ctx.performance_ratio()
    items = [(num(ctx.kwp(), 2), "kWp ισχύς"), (num(ctx.layout.get("count")), "πάνελ")]
    if e:
        items += [(num(e.get("annual_kwh")), "kWh / έτος"), (num(e.get("specific_yield")), "kWh / kWp")]
    if pr:
        items.append((f"{num(pr * 100, 1)}%", "Performance ratio"))
    return items


# ---------------------------------------------------------------- cover
def cover(ctx: ReportContext) -> list:
    p, info, st = ctx.project, ctx.info, ctx.styles
    out = [
        Spacer(1, 0.6 * cm),
        Paragraph("ΜΕΛΕΤΗ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΥΣΤΗΜΑΤΟΣ", st["cover_kicker"]),
        Paragraph(_esc(p.get("name") or "Έργο"), st["cover_title"]),
    ]
    if info.get("address"):
        out.append(Paragraph(_esc(info["address"]), st["cover_sub"]))
    out.append(Spacer(1, 0.6 * cm))
    m = ctx.map_image()
    if m:
        out.append(Image(io.BytesIO(m[0]), CONTENT_W, CONTENT_W * 0.625))
        out.append(Spacer(1, 0.5 * cm))
    if ctx.layout:
        out += [ctx.kpis(headline_kpis(ctx)), Spacer(1, 0.8 * cm)]
    rows = [("Πελάτης", info.get("client")), ("Συντάκτης", info.get("author")),
            ("Ημερομηνία", date.today().strftime("%d/%m/%Y"))]
    out.append(ctx.kv_table([(k, v) for k, v in rows if v], col1=0.3))
    return out


# ---------------------------------------------------------------- sections
@section(10)
def summary_section(ctx: ReportContext):
    s, l, e, info = ctx.settings, ctx.layout, ctx.energy, ctx.info
    out = [ctx.heading("Σύνοψη έργου")]
    if l:
        text = (f"Προτείνεται φωτοβολταϊκό σύστημα ισχύος <b>{num(ctx.kwp(), 2)} kWp</b> με "
                f"<b>{num(l.get('count'))}</b> πάνελ, με κλίση {num(s.get('tilt_deg'))}° και "
                f"{compass(s.get('azimuth_deg', 180)).lower()} προσανατολισμό ({num(s.get('azimuth_deg'))}°).")
        if e:
            text += (f" Η αναμενόμενη ετήσια παραγωγή είναι <b>{num(e.get('annual_kwh'))} kWh</b>, "
                     f"δηλαδή {num(e.get('specific_yield'))} kWh ανά εγκατεστημένο kWp.")
        out += [ctx.para(text), Spacer(1, 10), ctx.kpis(headline_kpis(ctx)), Spacer(1, 12)]
    center = l.get("center")
    rows = [
        ("Όνομα έργου", ctx.project.get("name")),
        ("Πελάτης", info.get("client")),
        ("Διεύθυνση", info.get("address")),
        ("Συντεταγμένες", f"{center[0]:.5f}, {center[1]:.5f}" if center else None),
        ("Συντάκτης", info.get("author")),
        ("Ημερομηνία αναφοράς", date.today().strftime("%d/%m/%Y")),
    ]
    out.append(ctx.subheading("Στοιχεία έργου"))
    out.append(ctx.kv_table([(k, v) for k, v in rows if v]))
    return out


@section(20)
def layout_section(ctx: ReportContext):
    s, l = ctx.settings, ctx.layout
    if not l:
        return None
    out = [PageBreak(), ctx.heading("Διάταξη και στοιχεία συστήματος")]
    m = ctx.map_image()
    if m:
        out.append(Image(io.BytesIO(m[0]), CONTENT_W, CONTENT_W * 0.625))
        legend = ("<font color='#f59e0b'>■</font> Περιοχή εγκατάστασης &nbsp;&nbsp; "
                  "<font color='#ef4444'>■</font> Εμπόδια &nbsp;&nbsp; <font color='#2563eb'>■</font> Πάνελ")
        if not m[1]:
            legend += " &nbsp;&nbsp; (χωρίς δορυφορική εικόνα: δεν υπήρχε σύνδεση στο internet)"
        out += [Spacer(1, 4), ctx.para(legend, "small"), Spacer(1, 8)]
    power = s.get("panel_power_w")
    panel = s.get("panel_name") or (f"{num(power)} W" if power else "–")
    row_gap = l.get("row_gap_m")
    rows = [
        ("Εγκατεστημένη ισχύς (DC)", f"{num(ctx.kwp(), 2)} kWp"),
        ("Αριθμός πάνελ", num(l.get("count"))),
        ("Πάνελ", panel),
        ("Ισχύς πάνελ", f"{num(power)} W"),
        ("Διαστάσεις πάνελ", f"{num((s.get('panel_length_m') or 0) * 1000)} × "
                             f"{num((s.get('panel_width_m') or 0) * 1000)} mm"),
        ("Τοποθέτηση", MOUNTING.get(s.get("mounting"), "–")),
        ("Προσανατολισμός πάνελ", ORIENTATION.get(s.get("orientation"), "–")),
        ("Κλίση", f"{num(s.get('tilt_deg'))}°"),
        ("Αζιμούθιο", f"{num(s.get('azimuth_deg'))}° ({compass(s.get('azimuth_deg', 180))})"),
        ("Επιφάνεια περιοχής", f"{num(l.get('area_m2'), 1)} m²"),
        ("Επιφάνεια πάνελ", f"{num(l.get('module_area_m2'), 1)} m²"),
        ("Απόσταση από τα άκρα", f"{num(s.get('setback_m'), 2)} m"),
        ("Κενό μεταξύ σειρών", f"{num(row_gap, 2)} m" if row_gap is not None else "–"),
        ("Αριθμός εμποδίων", num(len(ctx.project.get("keepouts") or []))),
    ]
    out += [CondPageBreak(8 * cm), ctx.subheading("Στοιχεία συστήματος"), ctx.kv_table(rows)]
    return out


def _monthly_chart(monthly: list[dict]) -> Drawing:
    w, h = CONTENT_W, 6.2 * cm
    d = Drawing(w, h)
    c = VerticalBarChart()
    c.x, c.y, c.width, c.height = 1.4 * cm, 0.8 * cm, w - 1.8 * cm, h - 1.3 * cm
    c.data = [[m["kwh"] for m in monthly]]
    c.categoryAxis.categoryNames = [MONTHS_SHORT[m["month"] - 1] for m in monthly]
    c.bars[0].fillColor = ACCENT
    c.bars[0].strokeColor = None
    c.barSpacing = 2
    c.valueAxis.valueMin = 0
    c.valueAxis.labelTextFormat = lambda v: num(v)
    c.valueAxis.gridStrokeColor = BORDER
    c.valueAxis.visibleGrid = True
    c.valueAxis.strokeColor = BORDER
    c.categoryAxis.strokeColor = BORDER
    for ax in (c.valueAxis, c.categoryAxis):
        ax.labels.fontName = "DejaVu"
        ax.labels.fontSize = 7.5
        ax.labels.fillColor = MUTED
    c.barLabelFormat = lambda v: num(v)
    c.barLabels.fontName = "DejaVu"
    c.barLabels.fontSize = 6.5
    c.barLabels.fillColor = MUTED
    c.barLabels.nudge = 6
    d.add(c)
    d.add(String(0, h - 8, "kWh", fontName="DejaVu", fontSize=7.5, fillColor=MUTED))
    return d


@section(30)
def production_section(ctx: ReportContext):
    e = ctx.energy
    monthly = e.get("monthly") or []
    if not monthly:
        return None
    total = sum(m["kwh"] for m in monthly) or 1
    source = ("PVGIS (Κοινό Κέντρο Ερευνών της Ευρωπαϊκής Επιτροπής), με δορυφορικά δεδομένα ακτινοβολίας "
              "για τη συγκεκριμένη τοποθεσία." if e.get("source") == "PVGIS"
              else "Πρόχειρο μοντέλο καθαρού ουρανού (pvlib) χωρίς σύνδεση στο internet. "
                   "Η εκτίμηση είναι λιγότερο ακριβής.")
    out = [PageBreak(), ctx.heading("Παραγωγή ενέργειας"),
           ctx.kpis([(num(e.get("annual_kwh")), "kWh / έτος"),
                     (num(e.get("specific_yield")), "kWh / kWp"),
                     (num(e.get("annual_irradiation")), "kWh/m² ακτινοβολία στα πάνελ")]),
           ctx.subheading("Μηνιαία παραγωγή"), _monthly_chart(monthly), Spacer(1, 6)]
    rows = [[MONTHS[m["month"] - 1], num(m.get("irradiation"), 1), num(m["kwh"]),
             f"{num(m['kwh'] / total * 100, 1)}%"] for m in monthly]
    rows.append(["Σύνολο έτους", num(sum(m.get("irradiation") or 0 for m in monthly)), num(total), "100%"])
    out.append(ctx.data_table(["Μήνας", "Ακτινοβολία (kWh/m²)", "Παραγωγή (kWh)", "Ποσοστό έτους"], rows,
                              total_row=True))
    out += [Spacer(1, 6), ctx.para(f"Πηγή δεδομένων: {source}", "small")]
    return out


def signed_pct(loss_pct: float) -> str:
    """A loss as −2,6% and a gain as +0,9%."""
    return f"{'−' if loss_pct >= 0 else '+'}{num(abs(loss_pct), 1)}%"


def loss_steps(ctx: ReportContext) -> tuple[float, list[tuple[str, float, float]], float] | None:
    """(nominal kWh, [(label, % lost, kWh lost)], final kWh); the last step is whatever remains."""
    e = ctx.energy
    h, kwp, final = e.get("annual_irradiation"), ctx.kwp(), e.get("annual_kwh")
    if not (h and kwp and final):
        return None
    nominal = h * kwp
    losses = e.get("losses") or {}
    steps, cur = [], nominal
    for key, label in [("aoi", "Γωνία πρόσπτωσης (ανακλάσεις στο γυαλί)"),
                       ("spectral", "Φασματικές επιδράσεις"),
                       ("temperature", "Θερμοκρασία και χαμηλή ακτινοβολία")]:
        pct = losses.get(key)
        if pct is None:
            continue
        nxt = cur * (1 - pct / 100)
        steps.append((label, pct, cur - nxt))
        cur = nxt
    label = ("Απώλειες συστήματος (καλώδια, inverter κ.ά.)" if steps
             else "Συνολικές απώλειες (θερμοκρασία, inverter κ.ά.)")
    steps.append((label, (cur - final) / cur * 100, cur - final))
    return nominal, steps, final


def _loss_chart(nominal, steps, final) -> Drawing:
    row_h, label_w, value_w = 0.75 * cm, 6.6 * cm, 3.3 * cm
    bar_w = CONTENT_W - label_w - value_w
    rows = [("Ονομαστική ενέργεια (ακτινοβολία × kWp)", None, nominal)] + \
           [(lbl, pct, kwh) for lbl, pct, kwh in steps] + [("Τελική παραγωγή (AC)", None, final)]
    d = Drawing(CONTENT_W, row_h * len(rows))
    cur = nominal
    for i, (lbl, pct, kwh) in enumerate(rows):
        y = d.height - (i + 1) * row_h + 0.15 * cm
        bh = row_h - 0.3 * cm
        d.add(String(0, y + bh / 2 - 3, lbl, fontName="DejaVu", fontSize=7.5, fillColor=TEXT))
        if pct is None:
            colour = GOOD if i else MUTED
            d.add(Rect(label_w, y, bar_w * kwh / nominal, bh, fillColor=colour, strokeColor=None))
            value = f"{num(kwh)} kWh"
        else:
            after = cur - kwh
            d.add(Rect(label_w, y, bar_w * min(cur, after) / nominal, bh, fillColor=ACCENT, strokeColor=None))
            if kwh > 0:
                d.add(Rect(label_w + bar_w * after / nominal, y, bar_w * kwh / nominal, bh,
                           fillColor=LOSS, strokeColor=None))
            cur = after
            value = f"{signed_pct(pct)}  ({num(abs(kwh))} kWh)"
        d.add(String(CONTENT_W, y + bh / 2 - 3, value, fontName="DejaVu", fontSize=7.5,
                     fillColor=TEXT, textAnchor="end"))
    return d


@section(40)
def losses_section(ctx: ReportContext):
    res = loss_steps(ctx)
    if not res:
        return None
    nominal, steps, final = res
    pr = final / nominal
    out = [CondPageBreak(10 * cm), ctx.heading("Απώλειες ενέργειας"),
           ctx.para("Από την ηλιακή ενέργεια που φτάνει στα πάνελ μέχρι την ηλεκτρική ενέργεια που αποδίδει το "
                    "σύστημα χάνεται ένα μέρος σε κάθε στάδιο. Το διάγραμμα δείχνει πόση ενέργεια χάνεται σε "
                    "κάθε στάδιο μέσα στο έτος."),
           Spacer(1, 8), _loss_chart(nominal, steps, final), Spacer(1, 10)]
    rows = [(lbl, signed_pct(pct)) for lbl, pct, _ in steps]
    rows += [("Συνολικές απώλειες", signed_pct((1 - pr) * 100)),
             ("Performance ratio (PR)", f"{num(pr * 100, 1)}%")]
    out.append(ctx.kv_table(rows, col1=0.7))
    out += [Spacer(1, 6), ctx.para("Performance ratio: ο λόγος της πραγματικής παραγωγής προς τη θεωρητική "
                                   "παραγωγή χωρίς καμία απώλεια. Τιμές 75–85% θεωρούνται καλές.", "small")]
    return out


def _plugin_section(key: str, title: str):
    def render(ctx: ReportContext):
        data = ctx.project.get(key)
        if not isinstance(data, dict) or not isinstance(data.get("report"), dict):
            return None
        return [CondPageBreak(8 * cm), ctx.heading(title)] + ctx.block(data["report"])
    render.__name__ = f"{key}_section"
    return render


for _order, _key, _title in PLUGIN_SECTIONS:
    section(_order)(_plugin_section(_key, _title))


@section(90)
def notes_section(ctx: ReportContext):
    notes = [
        "Η παραγωγή είναι εκτίμηση με βάση ιστορικά μετεωρολογικά δεδομένα. Η πραγματική παραγωγή κάθε "
        "έτους μπορεί να διαφέρει, κυρίως λόγω καιρού.",
        "Η διάταξη των πάνελ προκύπτει από σχεδίαση πάνω σε δορυφορική εικόνα και πρέπει να επιβεβαιωθεί "
        "με αυτοψία και μετρήσεις στο σημείο.",
    ]
    if not ctx.project.get("shading"):
        notes.append("Δεν έχουν ληφθεί υπόψη σκιάσεις από γειτονικά κτίρια, δέντρα ή εμπόδια.")
    out = [CondPageBreak(5 * cm), ctx.subheading("Παραδοχές και σημειώσεις")]
    for n in notes:
        out.append(ctx.para(f"• {n}", "small"))
    return out


# ---------------------------------------------------------------- document
class _NumberedCanvas(rl_canvas.Canvas):
    """Canvas that knows the total page count, for "Σελίδα X από Y"."""

    def __init__(self, *args, **kwargs):
        self._title = kwargs.pop("title_text", "")
        super().__init__(*args, **kwargs)
        self._pages = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            if self._pageNumber > 1:
                self._decorate(total)
            super().showPage()
        super().save()

    def _decorate(self, total):
        self.saveState()
        self.setStrokeColor(ACCENT)
        self.setLineWidth(1.2)
        self.line(MARGIN, PAGE_H - MARGIN + 0.5 * cm, PAGE_W - MARGIN, PAGE_H - MARGIN + 0.5 * cm)
        self.setFont("DejaVu", 8)
        self.setFillColor(MUTED)
        self.drawString(MARGIN, PAGE_H - MARGIN + 0.7 * cm, self._title)
        self.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN + 0.7 * cm, "Μελέτη φωτοβολταϊκού συστήματος")
        self.drawString(MARGIN, MARGIN - 0.9 * cm, date.today().strftime("%d/%m/%Y"))
        self.drawRightString(PAGE_W - MARGIN, MARGIN - 0.9 * cm, f"Σελίδα {self._pageNumber} από {total}")
        self.restoreState()


def _cover_band(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, PAGE_H - 0.5 * cm, PAGE_W, 0.5 * cm, stroke=0, fill=1)
    canvas.rect(0, 0, PAGE_W, 0.25 * cm, stroke=0, fill=1)
    canvas.restoreState()


def build_pdf(project: dict, imagery: bool = True) -> bytes:
    ctx = ReportContext(project, imagery=imagery)
    buf = io.BytesIO()
    name = project.get("name") or "Έργο"
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=MARGIN, bottomMargin=MARGIN,
                          title=f"Μελέτη φωτοβολταϊκού – {name}", author=ctx.info.get("author") or "PV Designer")
    frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="main")
    doc.addPageTemplates([PageTemplate("cover", [frame], onPage=_cover_band), PageTemplate("body", [frame])])

    story = cover(ctx) + [NextPageTemplate("body"), PageBreak()]
    first = True
    for _, fn in SECTIONS:
        part = fn(ctx)
        if not part:
            continue
        if first and isinstance(part[0], PageBreak):
            part = part[1:]  # already on a fresh page after the cover
        first = False
        story += part
    doc.build(story, canvasmaker=lambda *a, **k: _NumberedCanvas(*a, title_text=name, **k))
    return buf.getvalue()


def filename(project: dict) -> str:
    name = re.sub(r'[\\/:*?"<>|]+', "", project.get("name") or "").strip() or "ergo"
    return f"Μελέτη ΦΒ - {name}.pdf"
