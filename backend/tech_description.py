"""Technical description of the electrical installation (PDF), as DEDDIE asks with a connection application.

Built from the project data (panel values from project["electrical"]["inputs"], the electrical design, the layout).
Values that the engineer decides (cable types, breaker ratings, earthing) are indicative or left as "……", and
project["single_line"] may override them (same keys as single_line.py). Must be checked and signed by an engineer.
"""
from __future__ import annotations

import io
from datetime import date

from reportlab.lib.pagesizes import A4
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer

from . import i18n, report, single_line

BLANK = single_line.BLANK


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def build_tech_description_pdf(project: dict, lang: str = "el") -> bytes:
    """Raises ValueError when there is no electrical design yet."""
    token = report._LANG.set(lang if lang in i18n.LANGS else "el")
    try:
        return _build(project)
    finally:
        report._LANG.reset(token)


def _build(project: dict) -> bytes:
    tr, num = report.tr, report.num
    elec = project.get("electrical") or {}
    d = elec.get("design")
    if not d or not d.get("per_inverter"):
        raise ValueError("Κάνε πρώτα τον ηλεκτρολογικό σχεδιασμό (βήμα «Inverter»).")
    inp = elec.get("inputs") or {}
    inv = d["inverter"]
    s = project.get("settings") or {}
    info = project.get("report_info") or {}
    layout = project.get("layout") or {}
    over = project.get("single_line") or {}
    k = d["n_inverters"]
    phases = int(inv.get("phases") or 3)
    i_ac = single_line.ac_current(inv["pac_w"], phases)
    brk = over.get("ac_breaker_a") or single_line.breaker_for(i_ac)
    n_modules = d.get("modules_used") or layout.get("count")

    ctx = report.ReportContext(project, imagery=False)
    st = ctx.styles
    story = [Paragraph(_esc_(tr("ΤΕΧΝΙΚΗ ΠΕΡΙΓΡΑΦΗ ΗΛΕΚΤΡΟΛΟΓΙΚΗΣ ΕΓΚΑΤΑΣΤΑΣΗΣ ΦΩΤΟΒΟΛΤΑΪΚΟΥ ΣΤΑΘΜΟΥ")), st["h1"]),
             Spacer(1, 4),
             ctx.kv_table([
                 (tr("Έργο"), project.get("name") or "–"),
                 (tr("Πελάτης"), info.get("client") or "–"),
                 (tr("Διεύθυνση"), info.get("address") or "–"),
                 (tr("Ημερομηνία"), date.today().strftime("%d/%m/%Y")),
             ])]

    story += [ctx.subheading("1. Φωτοβολταϊκά πλαίσια"), ctx.kv_table([
        (tr("Πλήθος πλαισίων"), num(n_modules)),
        (tr("Μοντέλο"), s.get("panel_name") or "–"),
        (tr("Ισχύς πλαισίου"), f"{num(s.get('panel_power_w'))} Wp"),
        ("Voc / Isc", f"{num(_f(inp.get('modVoc')), 2)} V / {num(_f(inp.get('modIsc')), 2)} A"),
        ("Vmp / Imp", f"{num(_f(inp.get('modVmp')), 2)} V / {num(_f(inp.get('modImp')), 2)} A"),
        (tr("Διαστάσεις πάνελ"), f"{num((s.get('panel_length_m') or 0) * 1000)} × "
                                 f"{num((s.get('panel_width_m') or 0) * 1000)} mm"),
        (tr("Εγκατεστημένη ισχύς (DC)"), f"{num(d.get('dc_kwp'), 2)} kWp"),
        (tr("Τοποθέτηση"), tr(report.MOUNTING.get(s.get("mounting"), "–"))),
        (tr("Κλίση"), f"{num(s.get('tilt_deg'))}°"),
        (tr("Αζιμούθιο"), f"{num(s.get('azimuth_deg'))}° ({report.compass(s.get('azimuth_deg', 180))})"),
    ])]

    story += [ctx.subheading("2. Αντιστροφέας (inverter)"), ctx.kv_table([
        (tr("Πλήθος αντιστροφέων"), num(k)),
        (tr("Μοντέλο"), inv.get("name") or "–"),
        (tr("Ονομαστική ισχύς AC"), f"{num(inv['pac_w'] / 1000, 2)} kW"),
        (tr("Μέγιστη ισχύς DC"), f"{num(inv['pdc_max_w'] / 1000, 2)} kWp"),
        (tr("Φάσεις"), tr("Μονοφασικός") if phases == 1 else tr("Τριφασικός")),
        (tr("Μέγιστη τάση DC"), f"{num(inv['vdc_max'])} V"),
        (tr("Εύρος MPPT"), f"{num(inv['v_mppt_min'])}–{num(inv['v_mppt_max'])} V"),
        (tr("Είσοδοι MPPT"), f"{num(inv['n_mppt'])} × {num(inv['strings_per_mppt'])} strings"),
        (tr("Βαθμός απόδοσης"), f"{num(inv.get('eff_pct'), 1)} %"),
        (tr("Ονομαστικό ρεύμα AC"), f"{num(i_ac, 1)} A"),
    ])]

    rows = []
    for i in range(k):
        for j in range(inv["n_mppt"]):
            n, label = single_line._mppt_label(d, i, j)
            if n:
                rows.append((f"{tr('Inverter')} {i + 1} · MPPT {j + 1}", label))
    v, c = d.get("voltages") or {}, d.get("currents") or {}
    story += [ctx.subheading("3. Συνδεσμολογία και ηλεκτρικά μεγέθη DC"), ctx.kv_table(rows + [
        (tr("Πάνελ ανά string"), num(d.get("modules_per_string"))),
        (tr("Μέγιστη τάση string στο κρύο (Voc)"), f"{num(v.get('voc_cold'))} V"),
        (tr("Ελάχιστη τάση λειτουργίας στη ζέστη"), f"{num(v.get('vmp_hot'))} V"),
        (tr("Ρεύμα ανά MPPT (Imp / Isc)"), f"{num(c.get('imp_mppt'), 1)} A / {num(c.get('isc_mppt'), 1)} A"),
        (tr("Λόγος DC/AC"), num(d.get("dc_ac_ratio"), 2)),
    ])]

    story += [ctx.subheading("4. Καλώδια, προστασίες και γείωση"), ctx.kv_table([
        (tr("Καλώδιο DC (ΦΒ)"), f"{tr('ειδικό ΦΒ, διατομή')} {over.get('dc_cable') or BLANK} mm²"),
        (tr("Καλώδιο AC"), f"{tr('διατομή')} {over.get('ac_cable') or BLANK} mm²"),
        (tr("Διακόπτης DC"), tr("αποζεύκτης στον inverter")),
        (tr("Προστασία AC"), f"{tr('Αυτόματος')} {num(brk)} A" + (f" × {k}" if k > 1 else "")),
        (tr("Ρελέ διαρροής"), f"{over.get('rcd_ma') or 30} mA"),
        (tr("Αντικεραυνική προστασία"), tr("SPD στην πλευρά AC")),
        (tr("Γείωση"), over.get("earthing") or BLANK),
    ])]

    story += [ctx.subheading("5. Σύνδεση με το Δίκτυο"), ctx.kv_table([
        (tr("Τάση σύνδεσης"), "1~ 230 V, 50 Hz" if phases == 1 else "3~ 400/230 V, 50 Hz"),
        (tr("Μέγιστη ισχύς παραγωγής (AC)"), f"{num(d.get('ac_kw'), 2)} kW"),
        (tr("Μετρητής"), tr("αμφίδρομος ΔΕΔΔΗΕ (συμψηφισμός)")),
    ])]

    story += [ctx.subheading("6. Χωροθέτηση"), ctx.para(_esc_(tr(
        "Η χωροθέτηση των πλαισίων φαίνεται στο σχέδιο κάτοψης (επιφάνεια πλαισίων {m} m²). "
        "Οι συντεταγμένες των κορυφών της περιοχής εγκατάστασης δίνονται στη 2η σελίδα της κάτοψης."
    )).format(m=num(layout.get("module_area_m2"), 1)))]

    story += [Spacer(1, 14), ctx.para(_esc_(tr(
        "Ενδεικτικό κείμενο: τα στοιχεία των προστασιών και των καλωδίων πρέπει να ελεγχθούν και να υπογραφούν "
        "από τον υπεύθυνο μηχανικό/ηλεκτρολόγο.")), "small")]

    buf = io.BytesIO()
    name = project.get("name") or tr("Έργο")
    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=report.MARGIN, rightMargin=report.MARGIN,
                          topMargin=report.MARGIN, bottomMargin=report.MARGIN,
                          title=f"{tr('Τεχνική περιγραφή ηλεκτρολογικής εγκατάστασης')} – {name}",
                          author=info.get("author") or "PV Designer")
    doc.addPageTemplates([PageTemplate("body", [Frame(report.MARGIN, report.MARGIN, report.CONTENT_W,
                                                      A4[1] - 2 * report.MARGIN, id="main")])])
    doc.build(story)
    return buf.getvalue()


def _esc_(s: str) -> str:
    return report._esc(s)


def filename(project: dict, lang: str = "el") -> str:
    base = report.filename(project, lang)[:-4]
    return i18n.tr("Τεχνική περιγραφή ΦΒ - {name}.pdf", lang).format(name=base.split(" - ", 1)[-1])
