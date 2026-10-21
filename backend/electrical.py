"""Electrical design: pick inverters and size strings like HelioScope does.

String length is bounded by voltage: the open-circuit voltage on the coldest
morning must stay below the inverter's maximum DC voltage, and the MPP voltage
on the hottest afternoon must stay above the bottom of the MPPT window. Strings
in parallel on one MPPT are bounded by its current limits. Among the valid
configurations, the one that connects the most panels on the fewest inverters,
with a DC/AC ratio closest to the target, wins.
"""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, Field

from .equipment import INVERTERS, Inverter

# Absorbed irradiance and PVsyst heat-loss factors (W/m²K) used for the hot
# cell temperature here and in the hourly simulation.
DESIGN_IRRADIANCE = 1000.0
U_C = {"rack": 29.0, "flush": 20.0}
ABSORPTION = 0.9
MODULE_EFFICIENCY = 0.2


class Module(BaseModel):
    power_w: float = Field(..., gt=0, lt=2000)
    voc: float = Field(..., gt=0, lt=200)
    isc: float = Field(..., gt=0, lt=50)
    vmp: float = Field(..., gt=0, lt=200)
    imp: float = Field(..., gt=0, lt=50)
    temp_coeff_voc_pct: float = Field(-0.27, ge=-1, le=0)
    temp_coeff_isc_pct: float = Field(0.048, ge=0, le=0.2)
    temp_coeff_pmax_pct: float = Field(-0.35, ge=-1, le=0)

    @property
    def temp_coeff_vmp_pct(self) -> float:
        # Pmp = Vmp * Imp, and Imp drifts about as Isc does.
        return self.temp_coeff_pmax_pct - self.temp_coeff_isc_pct


def hot_cell_temp(t_ambient: float, mounting: str) -> float:
    rise = DESIGN_IRRADIANCE * ABSORPTION * (1 - MODULE_EFFICIENCY) / U_C.get(mounting, U_C["rack"])
    return t_ambient + rise


def _at_temp(value: float, coeff_pct: float, t_cell: float) -> float:
    return value * (1 + coeff_pct / 100.0 * (t_cell - 25.0))


def _split(total: int, parts: int) -> list[int]:
    base, extra = divmod(total, parts)
    return [base + (1 if i < extra else 0) for i in range(parts)]


class _Electrics:
    """Module voltages and currents at the design temperatures."""

    def __init__(self, m: Module, t_min: float, t_max: float, mounting: str):
        self.t_cold = t_min  # at dawn the cells are at ambient temperature
        self.t_hot = hot_cell_temp(t_max, mounting)
        self.voc_cold = _at_temp(m.voc, m.temp_coeff_voc_pct, self.t_cold)
        self.vmp_cold = _at_temp(m.vmp, m.temp_coeff_vmp_pct, self.t_cold)
        self.vmp_hot = _at_temp(m.vmp, m.temp_coeff_vmp_pct, self.t_hot)
        self.isc_hot = _at_temp(m.isc, m.temp_coeff_isc_pct, self.t_hot)
        self.imp = m.imp

    def string_range(self, inv: Inverter) -> tuple[int, int, int]:
        """(min, max by Vdc max, max that keeps cold Vmp inside the MPPT window)."""
        smin = max(1, math.ceil(max(inv.v_mppt_min, inv.v_start) / self.vmp_hot))
        smax = math.floor(inv.vdc_max / self.voc_cold)
        smax_mppt = math.floor(inv.v_mppt_max / self.vmp_cold)
        return smin, smax, smax_mppt

    def parallel_limit(self, inv: Inverter) -> int:
        by_isc = math.floor(inv.isc_max_mppt / self.isc_hot)
        by_imp = math.floor(inv.i_max_mppt / self.imp)
        return min(inv.strings_per_mppt, by_isc, by_imp)


def _layout(n_modules: int, inv: Inverter, k: int, s: int, per_mppt: int):
    strings = min(n_modules // s, k * inv.n_mppt * per_mppt)
    if strings == 0:
        return None
    per_inv = _split(strings, k)
    return strings, [{"strings": n, "mppts": _split(n, inv.n_mppt)} for n in per_inv]


def _face_string_length(n: int, lengths) -> int:
    """String length that connects the most of a face's n panels (longer strings on a tie); 0 if none fits."""
    fits = [s for s in lengths if s <= n]
    return max(fits, key=lambda s: ((n // s) * s, s)) if fits else 0


def _faces_layout(face_s: list[int], face_modules: list[int], inv: Inverter, k: int, per_mppt: int):
    """Strings of each roof face on their own MPPTs.

    Each face gets whole MPPTs (spread over the inverters). When the inverters have fewer MPPTs than the
    faces need, the remaining strings share an MPPT with another face; `shortage` counts those strings.
    """
    strings = [(n // s if s else 0) for s, n in zip(face_s, face_modules)]
    slots = [(i, j) for j in range(inv.n_mppt) for i in range(k)]  # interleaved: inverter 1 MPPT 1, inverter 2 MPPT 1...
    load = {sl: 0 for sl in slots}
    owners = {sl: [] for sl in slots}
    free = list(slots)
    placed = [0] * len(strings)
    shortage = 0
    for f in sorted(range(len(strings)), key=lambda f: -strings[f]):
        need = math.ceil(strings[f] / per_mppt) if strings[f] else 0
        mine, free = free[:need], free[need:]
        for sl, n in zip(mine, _split(strings[f], len(mine)) if mine else []):
            load[sl] += n
            owners[sl].append(f)
            placed[f] += n
        # No free MPPT left: share the least loaded MPPTs that still have room (faces mixed on one MPPT).
        while placed[f] < strings[f]:
            room = [sl for sl in slots if load[sl] < per_mppt]
            if not room:
                break
            sl = min(room, key=lambda x: load[x])
            load[sl] += 1
            if f not in owners[sl]:
                owners[sl].append(f)
            placed[f] += 1
            shortage += 1
    if not sum(placed):
        return None
    per_inv = [{"strings": sum(load[(i, j)] for j in range(inv.n_mppt)),
                "mppts": [load[(i, j)] for j in range(inv.n_mppt)],
                "mppt_faces": [sorted(owners[(i, j)]) for j in range(inv.n_mppt)]} for i in range(k)]
    return placed, per_inv, shortage


def _score(cfg, el, pmod, target, lo, hi):
    inv, k, s, strings, _ = cfg
    used = strings * s
    ratio = used * pmod / (k * inv.pac_w)
    smin, smax, _ = el.string_range(inv)
    # Configurations that break a hard limit only win when nothing else exists.
    broken = used * pmod / k > inv.pdc_max_w or not smin <= s <= smax
    outside = max(0.0, lo - ratio, ratio - hi)
    return (broken, round(outside, 3), -used, k, round(abs(ratio - target), 3), -s)


def design(
    module: Module,
    n_modules: int,
    inverter: Inverter | None = None,
    n_inverters: int | None = None,
    modules_per_string: int | None = None,
    t_min: float = -10.0,
    t_max: float = 40.0,
    mounting: str = "rack",
    dc_ac_target: float = 1.2,
    dc_ac_min: float = 1.0,
    dc_ac_max: float = 1.35,
    phases: Literal["auto", "1", "3"] = "auto",
    face_modules: list[int] | None = None,
    mix_faces: bool = False,
) -> dict:
    """face_modules (optional): panels on each roof face. Unless mix_faces, every string stays on one face
    and every face gets its own MPPT(s), so faces with a different tilt/azimuth do not pull each other down."""
    if face_modules:
        n_modules = sum(face_modules)
    by_face = bool(face_modules) and not mix_faces and sum(1 for n in face_modules if n > 0) > 1
    if n_modules < 1:
        raise ValueError("Δεν υπάρχουν πάνελ. Κάνε πρώτα τοποθέτηση πάνελ.")
    el = _Electrics(module, t_min, t_max, mounting)
    dc_w = n_modules * module.power_w

    if inverter is not None:
        candidates = [inverter]
    else:
        candidates = [i for i in INVERTERS if phases == "auto" or str(i.phases) == phases]
        if phases == "auto" and dc_w / dc_ac_target > 5000:
            candidates = [i for i in candidates if i.phases == 3]

    options = []
    for inv in candidates:
        smin, smax, smax_mppt = el.string_range(inv)
        if modules_per_string:
            lengths = [modules_per_string]
        else:
            top = min(smax, smax_mppt) if min(smax, smax_mppt) >= smin else smax
            lengths = range(smin, min(top, n_modules) + 1)
        per_mppt = el.parallel_limit(inv)
        if per_mppt < 1:
            if inverter is None:
                continue
            per_mppt = 1  # the checks will report the current problem
        if n_inverters:
            counts = [n_inverters]
        else:
            k_max = math.ceil(dc_w / (inv.pac_w * dc_ac_min)) + 1
            counts = range(1, min(k_max, 200) + 1)
        if by_face:
            face_s = [_face_string_length(n, lengths) for n in face_modules]
            for k in counts:
                lay = _faces_layout(face_s, face_modules, inv, k, per_mppt)
                if lay is None:
                    continue
                placed, per_inv, shortage = lay
                if sum(placed) < k and not n_inverters:
                    continue  # an inverter would be left with nothing connected
                options.append((inv, k, face_s, placed, per_inv, shortage))
            continue
        for s in lengths:
            for k in counts:
                lay = _layout(n_modules, inv, k, s, per_mppt)
                if lay is None:
                    continue
                strings, per_inv = lay
                if strings < k and not n_inverters:
                    continue  # an inverter would be left with nothing connected
                options.append((inv, k, s, strings, per_inv))
    if not options:
        smin = min(el.string_range(i)[0] for i in candidates)
        raise ValueError(
            f"Δεν βρέθηκε κατάλληλος συνδυασμός. Χρειάζονται τουλάχιστον {smin} πάνελ σε σειρά "
            "για να ξεκινήσει ο inverter, ή διάλεξε άλλο inverter."
        )
    if by_face:
        best = min(options, key=lambda c: _faces_score(c, el, module.power_w, dc_ac_target, dc_ac_min, dc_ac_max,
                                                       face_modules))
        inv, k, face_s, placed, per_inv, shortage = best
        return _describe((inv, k, face_s, placed, per_inv), module, n_modules, el, dc_ac_min, dc_ac_max,
                         face_modules=face_modules, shortage=shortage)
    best = min(options, key=lambda c: _score(c, el, module.power_w, dc_ac_target, dc_ac_min, dc_ac_max))
    inv, k, s, strings, per_inv = best
    if face_modules and not mix_faces:  # a single face with panels: the usual design, described per face
        lengths = [s if n else 0 for n in face_modules]
        counts = [strings if n else 0 for n in face_modules]
        for p in per_inv:
            p["mppt_faces"] = [[face_modules.index(next(n for n in face_modules if n))] if m else [] for m in p["mppts"]]
        return _describe((inv, k, lengths, counts, per_inv), module, n_modules, el, dc_ac_min, dc_ac_max,
                         face_modules=face_modules)
    res = _describe((inv, k, [s], [strings], per_inv), module, n_modules, el, dc_ac_min, dc_ac_max)
    if face_modules and mix_faces and sum(1 for n in face_modules if n > 0) > 1:
        res["checks"].append({"level": "warning", "text": (
            "Επέλεξες ανάμειξη πλευρών: ένα string μπορεί να έχει πάνελ από πλευρές με διαφορετικό "
            "προσανατολισμό. Η πιο αδύναμη πλευρά «τραβά» προς τα κάτω όλο το string, οπότε χάνεται παραγωγή.")})
        res["mix_faces"] = True
        res["report"] = report_block(res)
    return res


def _left_out(face_s, placed, face_modules) -> int:
    """Whole strings of the faces that found no room on any MPPT."""
    return sum((n // x if x else 0) - c for x, c, n in zip(face_s, placed, face_modules))


def _faces_score(cfg, el, pmod, target, lo, hi, modules):
    inv, k, face_s, placed, _, shortage = cfg
    used = sum(s * n for s, n in zip(face_s, placed))
    shortage += _left_out(face_s, placed, modules)
    ratio = used * pmod / (k * inv.pac_w)
    smin, smax, _ = el.string_range(inv)
    broken = used * pmod / k > inv.pdc_max_w or any(n and not smin <= s <= smax for s, n in zip(face_s, placed))
    outside = max(0.0, lo - ratio, ratio - hi)
    return (broken, round(outside, 3), shortage, -used, k, round(abs(ratio - target), 3))


def _describe(cfg, module: Module, n_modules: int, el: _Electrics, lo: float, hi: float,
              face_modules: list[int] | None = None, shortage: int = 0) -> dict:
    # Strings may have different lengths (one per roof face): the longest sets the cold voltages,
    # the shortest the hot one.
    inv, k, lengths, counts, per_inv = cfg
    live = [x for x, n in zip(lengths, counts) if n]
    s, s_short = max(live), min(live)
    strings = sum(counts)
    used = sum(x * n for x, n in zip(lengths, counts))
    dc_w = used * module.power_w
    ac_w = k * inv.pac_w
    ratio = dc_w / ac_w
    max_par = max(max(p["mppts"]) for p in per_inv)
    smin, smax, smax_mppt = el.string_range(inv)

    v = {
        "voc_cold": s * el.voc_cold,
        "vmp_cold": s * el.vmp_cold,
        "vmp_stc": s * module.vmp,
        "vmp_hot": s_short * el.vmp_hot,
    }
    i = {"isc_mppt": max_par * el.isc_hot, "imp_mppt": max_par * module.imp}

    checks = []

    def add(level, text):
        checks.append({"level": level, "text": text})

    t_cold, t_hot = f"{el.t_cold:.0f} °C", f"{el.t_hot:.0f} °C"
    if v["voc_cold"] > inv.vdc_max:
        add("error", f"Η τάση του string στο κρύο ({t_cold}) φτάνει {v['voc_cold']:.0f} V και ξεπερνά "
                     f"το όριο του inverter ({inv.vdc_max:.0f} V). Μπορεί να καταστραφεί ο inverter. "
                     f"Βάλε έως {smax} πάνελ σε σειρά.")
    else:
        add("ok", f"Μέγιστη τάση string στο κρύο ({t_cold}): {v['voc_cold']:.0f} V, κάτω από το όριο "
                  f"{inv.vdc_max:.0f} V.")
    if v["vmp_hot"] < max(inv.v_mppt_min, inv.v_start):
        add("warning", f"Στη ζέστη (κύτταρα {t_hot}) η τάση πέφτει στα {v['vmp_hot']:.0f} V, κάτω από το "
                       f"κατώτατο όριο λειτουργίας του inverter ({max(inv.v_mppt_min, inv.v_start):.0f} V). "
                       f"Θα χάνεται παραγωγή. Βάλε τουλάχιστον {smin} πάνελ σε σειρά.")
    else:
        add("ok", f"Ελάχιστη τάση λειτουργίας στη ζέστη (κύτταρα {t_hot}): {v['vmp_hot']:.0f} V, μέσα στο "
                  f"εύρος MPPT {inv.v_mppt_min:.0f}–{inv.v_mppt_max:.0f} V.")
    if v["vmp_cold"] > inv.v_mppt_max:
        add("warning", f"Στο κρύο η τάση λειτουργίας ({v['vmp_cold']:.0f} V) ξεπερνά το πάνω όριο MPPT "
                       f"({inv.v_mppt_max:.0f} V). Τις κρύες μέρες ο inverter δεν θα δουλεύει στο βέλτιστο σημείο.")
    if max_par > inv.strings_per_mppt:
        add("error", f"Συνδέονται {max_par} strings σε ένα MPPT, ενώ ο inverter έχει {inv.strings_per_mppt} είσοδο(ους).")
    if i["isc_mppt"] > inv.isc_max_mppt:
        add("error", f"Το ρεύμα βραχυκύκλωσης ανά MPPT ({i['isc_mppt']:.1f} A) ξεπερνά το όριο του inverter "
                     f"({inv.isc_max_mppt:.0f} A).")
    elif i["imp_mppt"] > inv.i_max_mppt:
        add("warning", f"Το ρεύμα ανά MPPT ({i['imp_mppt']:.1f} A) ξεπερνά το μέγιστο ρεύμα εισόδου "
                       f"({inv.i_max_mppt:.0f} A). Ο inverter θα κόβει λίγη παραγωγή.")
    else:
        add("ok", f"Ρεύμα ανά MPPT: {i['imp_mppt']:.1f} A (όριο {inv.i_max_mppt:.0f} A), βραχυκύκλωσης "
                  f"{i['isc_mppt']:.1f} A (όριο {inv.isc_max_mppt:.0f} A).")
    if ratio > hi:
        add("warning", f"Λόγος DC/AC {ratio:.2f}: αρκετά πάνελ για τον inverter, θα «ψαλιδίζεται» η παραγωγή "
                       "τις πολύ ηλιόλουστες ώρες.")
    elif ratio < lo:
        add("warning", f"Λόγος DC/AC {ratio:.2f}: ο inverter είναι μεγαλύτερος από όσο χρειάζεται.")
    else:
        add("ok", f"Λόγος DC/AC {ratio:.2f}, μέσα στο συνιστώμενο εύρος {lo:.2f}–{hi:.2f}.")
    if dc_w / k > inv.pdc_max_w:
        add("error", f"Η ισχύς πάνελ ανά inverter ({dc_w / k / 1000:.1f} kWp) ξεπερνά τη μέγιστη επιτρεπόμενη "
                     f"({inv.pdc_max_w / 1000:.1f} kWp).")
    if n_modules - used:
        add("warning", f"Συνδέονται {used} από τα {n_modules} πάνελ. Τα {n_modules - used} που περισσεύουν "
                       "δεν χωρούν σε ολόκληρο string: αφαίρεσέ τα ή άλλαξε τη διάταξη.")
    if inv.phases == 1 and ac_w > 5000:
        add("warning", "Στην Ελλάδα η μονοφασική σύνδεση επιτρέπεται συνήθως έως 5 kVA. Προτίμησε τριφασικό inverter.")
    if face_modules:
        faces_live = sum(1 for n in face_modules if n > 0)
        left_out = _left_out(lengths, counts, face_modules) if faces_live > 1 else 0
        if shortage or left_out:
            what = []
            if shortage:
                what.append(f"{shortage} string(s) μοιράζονται MPPT με άλλη πλευρά και χάνεται λίγη παραγωγή")
            if left_out:
                what.append(f"{left_out} string(s) δεν χωρούν σε κανένα MPPT και μένουν ασύνδετα")
            add("warning", f"Οι πλευρές της στέγης ({faces_live}) χρειάζονται περισσότερα MPPT από όσα έχει "
                           f"ο inverter ({k * inv.n_mppt}): {' και '.join(what)}. "
                           "Διάλεξε inverter με περισσότερα MPPT ή περισσότερους inverters.")
        for f, (n, x) in enumerate(zip(face_modules, lengths)):
            if n and not x:
                add("warning", f"Η πλευρά {f + 1} έχει μόνο {n} πάνελ, λιγότερα από τα {smin} που χρειάζεται "
                               "ένα string για αυτόν τον inverter. Δεν συνδέονται.")

    result = {
        "inverter": inv.model_dump(),
        "n_inverters": k,
        "modules_per_string": s,
        "n_strings": strings,
        "modules_used": used,
        "modules_unused": n_modules - used,
        "dc_kwp": round(dc_w / 1000, 3),
        "ac_kw": round(ac_w / 1000, 3),
        "dc_ac_ratio": round(ratio, 3),
        "per_inverter": per_inv,
        "string_range": {"min": smin, "max": smax, "max_in_mppt": smax_mppt},
        "temps": {"cell_min": round(el.t_cold, 1), "cell_max": round(el.t_hot, 1)},
        "voltages": {k_: round(x, 1) for k_, x in v.items()},
        "currents": {k_: round(x, 2) for k_, x in i.items()},
        "checks": checks,
        "ok": not any(c["level"] == "error" for c in checks),
    }
    if face_modules:
        result["faces"] = [{
            "modules": n, "modules_per_string": x if c else 0, "strings": c, "modules_used": x * c,
            "dc_kwp": round(x * c * module.power_w / 1000, 3),
            "mppts": sum(f in m for p in per_inv for m in p["mppt_faces"]),
        } for f, (n, x, c) in enumerate(zip(face_modules, lengths, counts))]
        result["mppt_shared"] = shortage > 0 or left_out > 0
    result["report"] = report_block(result)
    return result


def _num(v, d: int = 0) -> str:
    """Greek number format: 12.345,6"""
    return f"{v:,.{d}f}".replace(",", "§").replace(".", ",").replace("§", ".")


def report_block(d: dict) -> dict:
    """Summary, tables and notes for the electrical section of the PDF report."""
    inv, v, i, t = d["inverter"], d["voltages"], d["currents"], d["temps"]
    ok = lambda good: "✓" if good else "✗"
    summary = [
        ["Inverter", f"{d['n_inverters']} × {inv['name']}"],
        ["Σύνδεση", "Μονοφασική" if inv["phases"] == 1 else "Τριφασική"],
        ["Πάνελ σε σειρά (string)", str(d["modules_per_string"])],
        ["Πλήθος strings", str(d["n_strings"])],
        ["Συνδεδεμένα πάνελ", f"{d['modules_used']} από {d['modules_used'] + d['modules_unused']}"],
        ["Ισχύς DC / AC", f"{_num(d['dc_kwp'], 2)} kWp / {_num(d['ac_kw'], 1)} kW"],
        ["Λόγος DC/AC", _num(d["dc_ac_ratio"], 2)],
        ["Θερμοκρασίες κυττάρων σχεδιασμού", f"{_num(t['cell_min'])} έως {_num(t['cell_max'])} °C"],
    ]
    limits = [
        ["Μέγιστη τάση string (κρύο)", f"{_num(v['voc_cold'])} V", f"έως {_num(inv['vdc_max'])} V",
         ok(v["voc_cold"] <= inv["vdc_max"])],
        ["Τάση λειτουργίας (ζέστη)", f"{_num(v['vmp_hot'])} V", f"από {_num(inv['v_mppt_min'])} V",
         ok(v["vmp_hot"] >= max(inv["v_mppt_min"], inv["v_start"]))],
        ["Τάση λειτουργίας (κρύο)", f"{_num(v['vmp_cold'])} V", f"έως {_num(inv['v_mppt_max'])} V",
         ok(v["vmp_cold"] <= inv["v_mppt_max"])],
        ["Ρεύμα ανά MPPT", f"{_num(i['imp_mppt'], 1)} A", f"έως {_num(inv['i_max_mppt'])} A",
         ok(i["imp_mppt"] <= inv["i_max_mppt"])],
        ["Ρεύμα βραχυκύκλωσης ανά MPPT", f"{_num(i['isc_mppt'], 1)} A", f"έως {_num(inv['isc_max_mppt'])} A",
         ok(i["isc_mppt"] <= inv["isc_max_mppt"])],
    ]
    wiring = [[f"Inverter {n + 1}", str(p["strings"]), ", ".join(str(x) for x in p["mppts"])]
              for n, p in enumerate(d["per_inverter"])]
    tables = [
        {"title": "Έλεγχος τάσεων και ρευμάτων", "columns": ["Μέγεθος", "Τιμή", "Όριο inverter", "Έλεγχος"],
         "rows": limits},
        {"title": "Συνδεσμολογία", "columns": ["Inverter", "Strings", "Strings ανά MPPT"], "rows": wiring},
    ]
    if d.get("faces"):
        tables.append({
            "title": "Strings ανά πλευρά στέγης",
            "columns": ["Πλευρά", "Πάνελ", "Πάνελ σε σειρά", "Strings", "MPPT"],
            "rows": [[str(f + 1), f"{x['modules_used']} από {x['modules']}", str(x["modules_per_string"] or "–"),
                      str(x["strings"]), str(x["mppts"])] for f, x in enumerate(d["faces"])],
        })
    return {
        "summary": summary,
        "tables": tables,
        "notes": [c["text"] for c in d["checks"] if c["level"] != "ok"],
    }
