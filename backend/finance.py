"""Financial analysis of a PV system over its lifetime (Greek market defaults, euros).

Each year the system produces less (degradation). Part of the production is used
on site and saves the retail price; the rest goes to the grid and is valued
according to the scheme:

- self:         only self-consumption counts, exported energy earns nothing
- net_billing:  exported energy is sold at the export price
- net_metering: exported energy offsets later grid consumption at the offset
                price, up to the annual consumption (the surplus earns nothing)

Prices and O&M costs rise each year with their escalation rates. The inverter is
replaced once, in the given year.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass
class FinanceParams:
    kwp: float
    annual_kwh: float  # first-year production
    capex_per_kwp: float = 1100.0  # € per kWp, installed, with VAT
    subsidy_eur: float = 0.0
    scheme: Literal["self", "net_billing", "net_metering"] = "net_billing"
    self_consumption_pct: float = 40.0
    annual_consumption_kwh: float | None = None  # needed to cap net metering
    retail_price: float = 0.20  # €/kWh paid to the supplier, with charges
    export_price: float = 0.07  # €/kWh earned for exported energy (net billing)
    offset_price: float = 0.16  # €/kWh saved per offset kWh (net metering)
    price_escalation_pct: float = 2.0
    degradation_pct: float = 0.5
    om_per_kwp: float = 12.0  # € per kWp per year
    om_escalation_pct: float = 2.0
    inverter_replacement_year: int = 12  # 0 = no replacement
    inverter_cost_per_kwp: float = 120.0
    discount_rate_pct: float = 5.0
    lifetime_years: int = 25


def analyse(p: FinanceParams) -> dict:
    if p.kwp <= 0 or p.annual_kwh <= 0:
        raise ValueError("Χρειάζεται πρώτα υπολογισμός παραγωγής (kWp και kWh).")
    capex = p.kwp * p.capex_per_kwp
    investment = max(capex - p.subsidy_eur, 0.0)
    r = p.discount_rate_pct / 100.0
    self_share = min(max(p.self_consumption_pct, 0.0), 100.0) / 100.0

    years = []
    cumulative = -investment
    disc_cumulative = -investment
    pv_costs = investment
    pv_energy = 0.0
    for y in range(1, p.lifetime_years + 1):
        production = p.annual_kwh * (1 - p.degradation_pct / 100.0) ** (y - 1)
        price_factor = (1 + p.price_escalation_pct / 100.0) ** (y - 1)
        self_kwh = production * self_share
        if p.annual_consumption_kwh:
            self_kwh = min(self_kwh, p.annual_consumption_kwh)
        export_kwh = production - self_kwh

        savings = self_kwh * p.retail_price * price_factor
        if p.scheme == "net_billing":
            export_income = export_kwh * p.export_price * price_factor
        elif p.scheme == "net_metering":
            offset_kwh = export_kwh
            if p.annual_consumption_kwh:
                offset_kwh = min(export_kwh, max(p.annual_consumption_kwh - self_kwh, 0.0))
            export_income = offset_kwh * p.offset_price * price_factor
        else:
            export_income = 0.0

        om = p.kwp * p.om_per_kwp * (1 + p.om_escalation_pct / 100.0) ** (y - 1)
        replacement = p.kwp * p.inverter_cost_per_kwp if y == p.inverter_replacement_year else 0.0
        net = savings + export_income - om - replacement
        disc = (1 + r) ** y
        cumulative += net
        disc_cumulative += net / disc
        pv_costs += (om + replacement) / disc
        pv_energy += production / disc
        years.append({
            "year": y,
            "production_kwh": round(production),
            "self_kwh": round(self_kwh),
            "export_kwh": round(export_kwh),
            "savings": round(savings, 2),
            "export_income": round(export_income, 2),
            "om": round(om, 2),
            "replacement": round(replacement, 2),
            "net": round(net, 2),
            "cumulative": round(cumulative, 2),
            "discounted_cumulative": round(disc_cumulative, 2),
        })

    flows = [-investment] + [y["net"] for y in years]
    total_net = sum(flows[1:])
    result = {
        "capex": round(capex, 2),
        "investment": round(investment, 2),
        "first_year_benefit": round(years[0]["savings"] + years[0]["export_income"], 2),
        "first_year_net": years[0]["net"],
        "payback_years": _payback(investment, [y["cumulative"] for y in years]),
        "discounted_payback_years": _payback(investment, [y["discounted_cumulative"] for y in years]),
        "roi_pct": round((total_net - investment) / investment * 100, 1) if investment else None,
        "npv": round(_npv(r, flows), 2),
        "irr_pct": _irr(flows),
        "lcoe": round(pv_costs / pv_energy, 4) if pv_energy else None,
        "total_net": round(total_net, 2),
        "years": years,
    }
    result["report"] = report_block(p, result)
    return result


SCHEMES = {
    "self": "Μόνο ιδιοκατανάλωση",
    "net_billing": "Net billing (πώληση περίσσειας)",
    "net_metering": "Net metering (ενεργειακός συμψηφισμός)",
}


def _num(v, d: int = 0) -> str:
    """Greek number format: 12.345,6"""
    if v is None:
        return "–"
    s = f"{float(v):,.{d}f}"
    return s.replace(",", "§").replace(".", ",").replace("§", ".")


def report_block(p: FinanceParams, res: dict) -> dict:
    """Summary, cash-flow table and assumptions for the PDF report (see report.PLUGIN_SECTIONS)."""
    eur = lambda v: f"{_num(v)} €"
    years_text = lambda v: "δεν αποσβένεται" if v is None else f"{_num(v, 1)} έτη"
    summary = [
        ["Κόστος συστήματος", eur(res["capex"])],
    ]
    if res["investment"] != res["capex"]:
        summary.append(["Επένδυση μετά την επιδότηση", eur(res["investment"])])
    summary += [
        ["Τρόπος σύνδεσης", SCHEMES[p.scheme]],
        ["Όφελος 1ου έτους", eur(res["first_year_benefit"])],
        ["Απόσβεση", years_text(res["payback_years"])],
        ["Απόσβεση σε σημερινές τιμές", years_text(res["discounted_payback_years"])],
        ["Εσωτερικός βαθμός απόδοσης (IRR)", "–" if res["irr_pct"] is None else f"{_num(res['irr_pct'], 1)}%"],
        [f"Καθαρή παρούσα αξία (NPV, επιτόκιο {_num(p.discount_rate_pct, 1)}%)", eur(res["npv"])],
        [f"Συνολικό καθαρό κέρδος {len(res['years'])} ετών", eur(res["years"][-1]["cumulative"])],
        ["Απόδοση επένδυσης (ROI)", "–" if res["roi_pct"] is None else f"{_num(res['roi_pct'])}%"],
        ["Κόστος ενέργειας (LCOE)", "–" if res["lcoe"] is None else f"{_num(res['lcoe'], 3)} €/kWh"],
    ]
    rows = [
        [str(y["year"]), _num(y["production_kwh"]), eur(y["savings"] + y["export_income"]),
         eur(y["om"] + y["replacement"]), eur(y["net"]), eur(y["cumulative"])]
        for y in res["years"]
    ]
    export = {
        "net_billing": f"πώληση περίσσειας {_num(p.export_price, 3)} €/kWh, ",
        "net_metering": f"αξία συμψηφισμού {_num(p.offset_price, 3)} €/kWh, ",
    }.get(p.scheme, "")
    notes = [
        f"Παραδοχές: κόστος {_num(p.capex_per_kwp)} €/kWp με ΦΠΑ, τιμή ρεύματος {_num(p.retail_price, 3)} €/kWh, "
        f"{export}ιδιοκατανάλωση {_num(p.self_consumption_pct)}% της παραγωγής, αύξηση τιμών "
        f"{_num(p.price_escalation_pct, 1)}% τον χρόνο, μείωση απόδοσης πάνελ {_num(p.degradation_pct, 1)}% τον χρόνο, "
        f"συντήρηση {_num(p.om_per_kwp)} €/kWp τον χρόνο"
        + (f", αλλαγή inverter το {p.inverter_replacement_year}ο έτος ({_num(p.inverter_cost_per_kwp)} €/kWp)."
           if p.inverter_replacement_year else "."),
        "Τα οικονομικά αποτελέσματα είναι εκτίμηση. Οι τιμές ρεύματος και οι όροι των προγραμμάτων "
        "αλλάζουν, και δεν αποτελούν δέσμευση.",
    ]
    return {
        "summary": summary,
        "tables": [{
            "title": "Ταμειακές ροές ανά έτος",
            "columns": ["Έτος", "Παραγωγή (kWh)", "Όφελος", "Έξοδα", "Καθαρό", "Σωρευτικό"],
            "rows": rows,
        }],
        "notes": notes,
    }


def _npv(rate: float, flows: list[float]) -> float:
    return sum(f / (1 + rate) ** t for t, f in enumerate(flows))


def _irr(flows: list[float]) -> float | None:
    """Internal rate of return in %, by bisection. None when it doesn't exist."""
    lo, hi = -0.99, 1.0
    f_lo, f_hi = _npv(lo, flows), _npv(hi, flows)
    if f_lo * f_hi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = _npv(mid, flows)
        if f_lo * f_mid <= 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    return round((lo + hi) / 2 * 100, 2)


def _payback(investment: float, cumulative: list[float]) -> float | None:
    """Years until the cumulative cash flow turns positive, interpolated within the year."""
    if investment <= 0:
        return 0.0
    prev = -investment
    for i, c in enumerate(cumulative):
        if c >= 0:
            return round(i + (-prev) / (c - prev), 1)
        prev = c
    return None
