"""The battery of a project (project["battery"]) as it appears in the documents: report section, single-line
diagram, technical description, Appendix I and the phone app.

Schema: docs/streams/batteries.md, section 9. Only `enabled`, `inputs` and `result` are certain; `dispatch` and
project["finance"]["battery"] may be missing, so every reader here must cope with absent or partial data.
Without a battery (missing or enabled false) every function returns None and the documents stay as they were.
All texts are Greek, the English ones are in backend/i18n.py.
"""
from __future__ import annotations

from reportlab.lib.units import cm
from reportlab.platypus import CondPageBreak, Spacer

from . import report


def _f(v):
    """A number from a number or from the text of a form field ("12,5"); None when empty or not a number."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip().replace(",", "."))
        except ValueError:
            return None
    return None


def _dict(v) -> dict:
    return v if isinstance(v, dict) else {}


def battery_of(project: dict) -> dict | None:
    """project["battery"] when it is switched on, else None."""
    b = _dict(project).get("battery")
    return b if isinstance(b, dict) and b.get("enabled") is True else None


def facts(project: dict) -> dict | None:
    """The numbers of the battery that the documents show (any of them may be None), or None without a battery
    or when not even the capacity is known."""
    b = battery_of(project)
    if not b:
        return None
    res, inp, disp = _dict(b.get("result")), _dict(b.get("inputs")), _dict(b.get("dispatch"))
    bat = _dict(res.get("battery"))
    cap = _f(bat.get("capacity_kwh"))
    if cap is None:
        cap = _f(disp.get("capacity_kwh"))
    if cap is None:
        cap = _f(inp.get("batCap"))
    if not cap or cap <= 0:
        return None
    power = _f(bat.get("power_kw"))
    if power is None:
        power = _f(disp.get("power_kw"))
    if power is None:
        power = _f(inp.get("batPower"))
    usable = _f(bat.get("usable_kwh"))
    if usable is None:
        usable = _f(disp.get("usable_kwh"))
    fin = _dict(_dict(_dict(project).get("finance")).get("battery"))
    return {
        "capacity_kwh": cap, "power_kw": power, "usable_kwh": usable,
        "capex": _f(bat.get("capex")), "investment": _f(bat.get("investment")),
        "daily_kwh": _f(res.get("daily_kwh")), "peak_kw": _f(res.get("peak_kw")),
        "target_days": _f(res.get("target_days")),
        "days_full": _f(bat.get("days_full")), "days_guaranteed": _f(bat.get("days_guaranteed")),
        "capacity_ok": bat.get("capacity_ok") if isinstance(bat.get("capacity_ok"), bool) else None,
        "power_ok": bat.get("power_ok") if isinstance(bat.get("power_ok"), bool) else None,
        "loads": [r for r in (b.get("rows") or []) if isinstance(r, dict) and r.get("on") and r.get("name")],
        "dispatch": disp if _dict(disp.get("without")) and _dict(disp.get("with")) else None,
        "finance": fin or None,
    }


def _kwh(v, d=1):
    return f"{report.num(v, d)} kWh" if v is not None else "–"


def _kw(v, d=1):
    return f"{report.num(v, d)} kW" if v is not None else "–"


def _eur(v):
    return f"{report.num(v)} €" if v is not None else "–"


def _pct(v):
    return f"{report.num(v, 1)}%" if v is not None else "–"


def label(project: dict) -> str | None:
    """«Μπαταρία 10,0 kWh» (in the language of the document), for the diagram."""
    f = facts(project)
    return f"{report.tr('Μπαταρία')} {report.num(f['capacity_kwh'], 1)} kWh" if f else None


# ---------------------------------------------------------------- PDF report
def report_section(ctx) -> list | None:
    f = facts(ctx.project)
    if not f:
        return None
    tr, num = report.tr, report.num
    rows = [(tr("Χωρητικότητα μπαταρίας"), _kwh(f["capacity_kwh"])),
            (tr("Χρήσιμη ενέργεια"), _kwh(f["usable_kwh"])),
            (tr("Ισχύς μπαταρίας"), _kw(f["power_kw"]))]
    cost = f["investment"] if f["investment"] is not None else f["capex"]
    if cost is not None:
        rows.append((tr("Κόστος μπαταρίας (ενδεικτικό)"), _eur(cost)))
    if f["daily_kwh"] is not None:
        rows.append((tr("Φορτία εφεδρείας: ημερήσια ενέργεια"), _kwh(f["daily_kwh"], 2)))
    if f["peak_kw"] is not None:
        rows.append((tr("Φορτία εφεδρείας: κορυφή ισχύος"), _kw(f["peak_kw"], 2)))
    if f["days_full"] is not None:
        rows.append((tr("Ημέρες αυτονομίας χωρίς ήλιο"), num(f["days_full"], 1)))
    if f["target_days"] is not None:
        rows.append((tr("Στόχος αυτονομίας"), f"{num(f['target_days'], 1)} " + tr("ημέρες")))
    if f["capacity_ok"] is not None:
        rows.append((tr("Η χωρητικότητα φτάνει για τον στόχο"), tr("Ναι") if f["capacity_ok"] else tr("Όχι")))
    if f["power_ok"] is not None:
        rows.append((tr("Η ισχύς φτάνει για τα φορτία"), tr("Ναι") if f["power_ok"] else tr("Όχι")))
    out = [CondPageBreak(8 * cm), ctx.heading("Αποθήκευση ενέργειας (μπαταρία)"), ctx.kv_table(rows, col1=0.6)]

    if f["loads"]:
        table = [[r["name"], num(_f(r.get("kwh_day")), 2), num(_f(r.get("peak_w")))] for r in f["loads"]]
        out += [ctx.subheading("Φορτία εφεδρείας"),
                ctx.data_table([tr("Φορτίο"), tr("kWh / ημέρα"), tr("Ισχύς κορυφής (W)")], table,
                               widths=[report.CONTENT_W * w for w in (0.55, 0.2, 0.25)])]

    d = f["dispatch"]
    if d:
        wo, wi = _dict(d["without"]), _dict(d["with"])
        table = [[tr("Ιδιοκατανάλωση"), _pct(_f(wo.get("self_consumption_pct"))), _pct(_f(wi.get("self_consumption_pct")))],
                 [tr("Αυτάρκεια"), _pct(_f(wo.get("autarky_pct"))), _pct(_f(wi.get("autarky_pct")))],
                 [tr("Αγορά από το δίκτυο (kWh / έτος)"), num(_f(wo.get("import_kwh"))), num(_f(wi.get("import_kwh")))],
                 [tr("Εξαγωγή στο δίκτυο (kWh / έτος)"), num(_f(wo.get("export_kwh"))), num(_f(wi.get("export_kwh")))]]
        out += [ctx.subheading("Εξοικονόμηση με τη μπαταρία"),
                ctx.data_table([tr("Δείκτης"), tr("Χωρίς μπαταρία"), tr("Με μπαταρία")], table,
                               widths=[report.CONTENT_W * w for w in (0.5, 0.25, 0.25)])]
        if d.get("assumed_consumption"):
            out += [Spacer(1, 4), ctx.para(report._esc(tr(
                "Η ετήσια κατανάλωση είναι υπόθεση, όχι μέτρηση: τα αποτελέσματα αλλάζουν με την πραγματική κατανάλωση.")),
                "small")]

    fin = f["finance"]
    if fin:
        frows = []
        for key, text, fmt in (("extra_investment", "Επιπλέον επένδυση για τη μπαταρία", _eur),
                               ("first_year_gain", "Κέρδος πρώτου έτους από τη μπαταρία", _eur),
                               ("payback_years", "Απόσβεση της μπαταρίας (έτη)", lambda v: num(v, 1) if v is not None else "–"),
                               ("npv_gain", "Κέρδος NPV από τη μπαταρία", _eur)):
            if key in fin:
                frows.append((tr(text), fmt(_f(fin.get(key)))))
        if frows:
            out += [ctx.subheading("Οικονομικά της μπαταρίας"), ctx.kv_table(frows, col1=0.6)]

    out += [Spacer(1, 6), ctx.para(report._esc(tr(
        "Οι τιμές κόστους της μπαταρίας είναι ενδεικτικές και δεν έχουν επαληθευτεί με προσφορά προμηθευτή.")), "small"),
        ctx.para(report._esc(tr(
            "Οι ημέρες αυτονομίας προκύπτουν από τα φορτία εφεδρείας που επιλέχθηκαν· η πραγματική διάρκεια "
            "εξαρτάται από τη χρήση.")), "small")]
    return out


# ---------------------------------------------------------------- technical description
def description_rows(project: dict) -> list[tuple[str, str]] | None:
    """Rows of the «Σύστημα αποθήκευσης» table of the technical description (already in the document language)."""
    f = facts(project)
    if not f:
        return None
    tr = report.tr
    rows = [(tr("Χωρητικότητα μπαταρίας"), _kwh(f["capacity_kwh"])),
            (tr("Χρήσιμη ενέργεια"), _kwh(f["usable_kwh"])),
            (tr("Ισχύς μπαταρίας"), _kw(f["power_kw"])),
            (tr("Σύνδεση της μπαταρίας"), tr("μέσω υβριδικού αντιστροφέα ή μετατροπέα μπαταρίας, στην πλευρά του φωτοβολταϊκού")),
            (tr("Λειτουργία εφεδρείας"), tr("τροφοδοσία των επιλεγμένων φορτίων σε διακοπή του δικτύου"))]
    if f["daily_kwh"] is not None:
        rows.insert(3, (tr("Φορτία εφεδρείας (ημερήσια ενέργεια / κορυφή)"),
                        f"{_kwh(f['daily_kwh'], 2)} / {_kw(f['peak_kw'], 2)}"))
    if f["days_full"] is not None:
        rows.insert(4 if f["daily_kwh"] is not None else 3,
                    (tr("Ημέρες αυτονομίας χωρίς ήλιο"), report.num(f["days_full"], 1)))
    return rows


# ---------------------------------------------------------------- Appendix I (Greek only)
def appendix_rows(project: dict) -> list[tuple[str, str]] | None:
    """What the project knows for the «Σύστημα αποθήκευσης» part of Appendix I; the rest is for the engineer."""
    f = facts(project)
    if not f:
        return None
    return [("Κατασκευαστής:", ""), ("Τύπος - Μοντέλο:", ""),
            ("Χωρητικότητα (kWh)", report.num(f["capacity_kwh"], 1)),
            ("Ονομαστική ισχύς (kW)", report.num(f["power_kw"], 1) if f["power_kw"] is not None else "")]


# ---------------------------------------------------------------- phone
def mobile_summary(project: dict) -> dict | None:
    """Plain numbers for the phone app (it formats them), None without a battery."""
    f = facts(project)
    if not f:
        return None
    d = f["dispatch"]
    out = {k: f[k] for k in ("capacity_kwh", "power_kw", "usable_kwh", "days_full", "capacity_ok")}
    if d:
        out["self_consumption_without_pct"] = _f(_dict(d["without"]).get("self_consumption_pct"))
        out["self_consumption_with_pct"] = _f(_dict(d["with"]).get("self_consumption_pct"))
    return out
