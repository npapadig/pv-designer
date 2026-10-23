"""Pre-filled DEDDIE «Παράρτημα Ι» (technical data of the equipment of a PV station), Greek only like the official form.

Only what the project knows is filled (panel and inverter model, counts, powers, mounting). Values that come from the
manufacturer's datasheet (manufacturer, certificates, power factor, THD, ...) stay empty, to be completed by the
engineer, who also signs. The official form is at deddie.gr (revision 16.01.2026); this follows its fields.
"""
from __future__ import annotations

import io

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

from . import report

ON, OFF = "☒", "☐"


def _num(v, d=0):
    return "" if v is None else report.num(v, d)


def build_appendix_i_pdf(project: dict) -> bytes:
    """Raises ValueError when there is no electrical design yet."""
    d = (project.get("electrical") or {}).get("design")
    if not d or not d.get("per_inverter"):
        raise ValueError("Κάνε πρώτα τον ηλεκτρολογικό σχεδιασμό (βήμα «Inverter»).")
    token = report._LANG.set("el")
    try:
        return _build(project, d)
    finally:
        report._LANG.reset(token)


def _build(project: dict, d: dict) -> bytes:
    s = project.get("settings") or {}
    inv = d["inverter"]
    info = project.get("report_info") or {}
    ctx = report.ReportContext(project, imagery=False)
    st = ctx.styles
    cell = st["cell"]
    bold = ParagraphStyle("b", cell, fontName="DejaVu-Bold")
    w = report.CONTENT_W

    def P(text, style=cell):
        return Paragraph(report._esc(text), style)

    def table(rows):
        data = []
        styles = [("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                  ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]
        for r in rows:
            if len(r) == 1:  # full-width row
                data.append([P(r[0]), ""])
                styles.append(("SPAN", (0, len(data) - 1), (1, len(data) - 1)))
            else:
                data.append([P(r[0]), P(r[1], bold)])
        t = Table(data, colWidths=[w * 0.5, w * 0.5])
        t.setStyle(TableStyle(styles))
        return t

    yes_no = f"{OFF} ΝΑΙ    {OFF} ΟΧΙ"
    story = [
        Paragraph("ΠΑΡΑΡΤΗΜΑ Ι", st["h1"]),
        Paragraph("ΤΕΧΝΙΚΑ ΣΤΟΙΧΕΙΑ ΕΞΟΠΛΙΣΜΟΥ ΓΙΑ ΦΩΤΟΒΟΛΤΑΪΚΟ ΣΤΑΘΜΟ", st["h2"]),
        Paragraph(report._esc(f"Έργο: {project.get('name') or '–'}   ·   Πελάτης: {info.get('client') or '–'}   ·   "
                              f"Διεύθυνση: {info.get('address') or '–'}"), st["small"]),
        Spacer(1, 8),
        Paragraph("1. Τεχνικά Στοιχεία ΦΒ Σταθμού", st["h2"]),
        Paragraph("1.1 Στοιχεία Φωτοβολταϊκών Πλαισίων", st["h2"]),
        table([
            (f"{ON} Σταθερά συστήματα      {OFF} Συστήματα ηλιακής ιχνηλάτησης (trackers)",),
            (f"{OFF} Μονής όψης      {OFF} Διπλής όψης (Bifacial)",),
            ("Κατασκευαστής:", ""),
            ("Τύπος - Μοντέλο:", s.get("panel_name") or ""),
            ("Πλήθος πλαισίων", _num(d.get("modules_used"))),
            ("Ονομαστική ισχύς πλαισίου (Wp)", _num(s.get("panel_power_w"))),
            ("Πιστοποιήσεις:", ""),
        ]),
        Paragraph("1.2 Στοιχεία Μετατροπέων", st["h2"]),
        table([
            ("Κατασκευαστής:", ""),
            ("Τύπος - Μοντέλο:", inv.get("name") or ""),
            ("Πλήθος μετατροπέων", _num(d.get("n_inverters"))),
            ("Ονομαστική ισχύς εξόδου (kW)", _num(inv["pac_w"] / 1000, 2)),
            ("Μέγιστη ισχύς εξόδου (kW)", ""),
            ("Συντελεστής ισχύος", ""),
            ("Μέγιστος βαθμός απόδοσης ηmax", ""),
            ("Διακύμανση τάσης εξόδου (δυνατό εύρος ρύθμισης)", ""),
            ("Διακύμανση συχνότητας εξόδου (δυνατό εύρος ρύθμισης)", ""),
            ("Ολική αρμονική παραμόρφωση ρεύματος (THD)", ""),
            ("Μετασχηματιστής απομόνωσης", yes_no),
            ("Έγχυση DC συνιστώσας ρεύματος (στην πλευρά ΧΤ)", ""),
            ("Προστασία έναντι νησιδοποίησης (islanding) κατά VDE 0126 ή ισοδύναμης μεθόδου", yes_no),
            ("Πιστοποίηση συμμόρφωσης με τον Κανονισμό (ΕΕ) 2016/631 (RfG), κατά EN 50549-1 ή EN 50549-2", yes_no),
            ("Πλήρης περιγραφή του τρόπου προστασίας:", ""),
            ("Πιστοποιήσεις:", ""),
        ]),
        Spacer(1, 8),
        Paragraph("1.3 Μετασχηματιστής ανύψωσης ΧΤ/ΜΤ και 2. Σύστημα αποθήκευσης: δεν συμπληρώνονται "
                  "(σύνδεση στη ΧΤ, χωρίς αποθήκευση).", st["small"]),
        Spacer(1, 6),
        Paragraph("Προσυμπληρώθηκαν μόνο τα στοιχεία που γνωρίζει η εφαρμογή. Τα υπόλοιπα (κατασκευαστής, "
                  "πιστοποιήσεις, συντελεστής ισχύος, THD κ.λπ.) συμπληρώνονται από τα τεχνικά φυλλάδια του "
                  "κατασκευαστή. Το επίσημο έντυπο βρίσκεται στο deddie.gr (ενημέρωση 16.01.2026).", st["small"]),
        Spacer(1, 22),
        Paragraph("Ο/Η υπεύθυνος/-η μηχανικός (Ονοματεπώνυμο / Σφραγίδα)", cell),
        Spacer(1, 30),
        Paragraph("………………………………… (Υπογραφή)          ………………………………… (Πόλη / Ημερομηνία)", cell),
    ]
    buf = io.BytesIO()
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=report.MARGIN, rightMargin=report.MARGIN,
                          topMargin=40, bottomMargin=40, title="Παράρτημα Ι – " + (project.get("name") or ""),
                          author=info.get("author") or "PV Designer")
    doc.addPageTemplates([PageTemplate("p", [Frame(report.MARGIN, 40, w, A4[1] - 80, id="m")])])
    doc.build(story)
    return buf.getvalue()


def filename(project: dict) -> str:
    base = report.filename(project, "el")[:-4]
    return f"Παράρτημα Ι ΦΒ - {base.split(' - ', 1)[-1]}.pdf"
