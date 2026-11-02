"""Battery (energy storage): how long it keeps chosen loads running when the grid is down.

Model (closed form, no weather needed; the hourly saving model comes in a later release, see
docs/streams/batteries.md):
- The loads to keep (fridge, lights, ...) need E_day kWh per day and at most P_peak kW at the same time
  (the sum of their peak powers times a simultaneity factor).
- The battery has a nominal capacity; only `usable_pct` of it may be used (depth of discharge). Discharging
  loses a little: the round trip efficiency is split evenly between charging and discharging, and the
  charging half is already "paid" when the energy is in the battery, so only sqrt(round trip) applies
  when it comes out.
- `reserve_pct` is the part of the usable energy that is always kept for an outage (100 = a pure backup battery
  that stays full, 0 = only used for saving money). Days of autonomy are counted for a full battery and for
  the guaranteed (reserve) part.
- Nothing recharges it in this version (the pessimistic "no sun" case).

Not modelled on purpose: start-up surges of appliances, phase limits, temperature effects.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

# Typical appliances (average energy per day and power while running). Indicative values the user can edit.
# groups: which ready-made sets the appliance belongs to.
APPLIANCES = [
    {"key": "fridge", "name": "Ψυγείο", "kwh_day": 1.0, "peak_w": 150, "groups": ["basic", "comfort"]},
    {"key": "freezer", "name": "Καταψύκτης", "kwh_day": 1.0, "peak_w": 150, "groups": ["basic", "comfort"]},
    {"key": "lights", "name": "Φωτισμός LED", "kwh_day": 0.6, "peak_w": 300, "groups": ["basic", "comfort"]},
    {"key": "router", "name": "Router / Wi-Fi", "kwh_day": 0.25, "peak_w": 15, "groups": ["basic", "comfort"]},
    {"key": "tv", "name": "Τηλεόραση", "kwh_day": 0.5, "peak_w": 150, "groups": ["basic", "comfort"]},
    {"key": "phones", "name": "Φορτιστές κινητών", "kwh_day": 0.1, "peak_w": 25, "groups": ["basic", "comfort"]},
    {"key": "computer", "name": "Υπολογιστής / laptop", "kwh_day": 0.4, "peak_w": 100, "groups": ["comfort"]},
    {"key": "pump", "name": "Αντλία νερού / πιεστικό", "kwh_day": 0.5, "peak_w": 750, "groups": ["comfort"]},
    {"key": "circulator", "name": "Κυκλοφορητής / καυστήρας", "kwh_day": 0.3, "peak_w": 150, "groups": ["comfort"]},
    {"key": "washer", "name": "Πλυντήριο ρούχων", "kwh_day": 0.8, "peak_w": 2000, "groups": ["comfort"]},
    {"key": "microwave", "name": "Μικροκύματα / βραστήρας", "kwh_day": 0.4, "peak_w": 2000, "groups": ["comfort"]},
    {"key": "ac", "name": "Κλιματιστικό (1 μονάδα)", "kwh_day": 3.0, "peak_w": 1200, "groups": ["comfort"]},
    {"key": "boiler", "name": "Θερμοσίφωνας", "kwh_day": 3.0, "peak_w": 3000, "groups": []},
    {"key": "cooker", "name": "Ηλεκτρική κουζίνα", "kwh_day": 2.0, "peak_w": 3000, "groups": []},
]

# Whole house: one row with the average daily consumption (the app fills it from the yearly consumption).
HOUSE_DEFAULT_KWH_DAY = 12.0
HOUSE_PEAK_W = 6000

SIMULTANEITY_PCT = 70.0     # share of the summed peak powers that run at the same time
POWER_PER_KWH = 0.5         # automatic battery power: kW per kWh of capacity (a common home battery ratio)
DAYS_CARDS = (1.0, 2.0, 3.0)
PER_KWP_KWH = 1.0           # rule of thumb for daily use: 1 kWh of battery per kWp of panels
MIN_CARD_KWH = 2.5
MAX_DAYS = 365.0

# Generic sizes (the real catalog comes later). power_kw None = automatic (POWER_PER_KWH), like an empty power field.
PRESET_BATTERIES = [{"name": f"Γενική μπαταρία {c:g} kWh", "capacity_kwh": c, "power_kw": None} for c in (5, 10, 15, 20)]

DEFAULT_COST_PER_KWH = 800.0  # € per kWh installed with VAT: an indicative market value, not a checked price

CATALOG_FILE = Path(__file__).parent / "catalog" / "batteries.json"


class CatalogBattery(BaseModel):
    """A real product in one fixed configuration, from the public datasheet of the manufacturer (see `source`)."""
    name: str = Field(..., min_length=3)
    brand: str = Field(..., min_length=2)
    chemistry: Literal["LFP", "NMC", "other"]
    capacity_kwh: float = Field(..., gt=0, lt=500, description="the capacity the datasheet calls nominal/total")
    usable_kwh: float = Field(..., gt=0, lt=500, description="usable energy; equal to capacity when only one figure is given")
    power_kw: float = Field(..., gt=0, lt=200, description="continuous discharge power of this configuration")
    peak_power_kw: float | None = Field(None, gt=0, lt=400)
    roundtrip_pct: float | None = Field(None, gt=50, le=100, description="None when the datasheet gives none")
    coupling: Literal["ac", "dc"] = Field(..., description="dc = needs the manufacturer's hybrid inverter")
    cycles: int | None = Field(None, gt=0, lt=100000)
    warranty_years: int | None = Field(None, gt=0, lt=50)
    eol_capacity_pct: float | None = Field(None, gt=0, le=100, description="capacity left at the end of the warranty")
    notes: str = ""
    source: str = Field(..., min_length=5)

    @model_validator(mode="after")
    def _usable_fits(self):
        if self.usable_kwh > self.capacity_kwh + 1e-9:
            raise ValueError("usable_kwh cannot be larger than capacity_kwh")
        return self


def load_catalog(path: Path = CATALOG_FILE) -> list[CatalogBattery]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [CatalogBattery(**row) for row in json.load(f)]


CATALOG_BATTERIES: list[CatalogBattery] = load_catalog()


class LoadItem(BaseModel):
    kwh_day: float = Field(0, ge=0, le=1000)
    peak_w: float = Field(0, ge=0, le=1_000_000)


class BatteryParams(BaseModel):
    capacity_kwh: float = Field(0, ge=0, le=5000)
    power_kw: float | None = Field(None, ge=0, le=2000, description="None = automatic")
    usable_pct: float = Field(90, gt=0, le=100)
    roundtrip_pct: float = Field(90, gt=50, le=100)
    reserve_pct: float = Field(100, ge=0, le=100)
    cost_per_kwh: float = Field(DEFAULT_COST_PER_KWH, ge=0)
    cost_fixed: float = Field(0, ge=0)
    subsidy_eur: float = Field(0, ge=0)
    fade_pct_per_year: float = Field(2.0, ge=0, le=20, description="capacity lost for every year of age")
    replacement_year: int = Field(12, ge=0, le=40, description="year of a new battery; 0 = never")
    replacement_cost_pct: float = Field(60.0, ge=0, le=300, description="price of the new battery, % of the first one")


class AutonomyRequest(BaseModel):
    loads: list[LoadItem] = []
    simultaneity_pct: float = Field(SIMULTANEITY_PCT, gt=0, le=100)
    target_days: float = Field(1, gt=0, le=MAX_DAYS)
    battery: BatteryParams = BatteryParams()
    kwp: float | None = Field(None, ge=0, description="size of the panels, for the per-kWp proposal")


def presets() -> dict:
    return {
        "appliances": APPLIANCES,
        "sets": {
            "basic": [a["key"] for a in APPLIANCES if "basic" in a["groups"]],
            "comfort": [a["key"] for a in APPLIANCES if "comfort" in a["groups"]],
        },
        "house": {"kwh_day": HOUSE_DEFAULT_KWH_DAY, "peak_w": HOUSE_PEAK_W},
        "batteries": PRESET_BATTERIES,
        "catalog": [b.model_dump() for b in CATALOG_BATTERIES],
        "defaults": {
            "simultaneity_pct": SIMULTANEITY_PCT, "usable_pct": 90, "roundtrip_pct": 90, "reserve_pct": 100,
            "cost_per_kwh": DEFAULT_COST_PER_KWH, "power_per_kwh": POWER_PER_KWH, "target_days": 1,
            "fade_pct_per_year": 2, "replacement_year": 12, "replacement_cost_pct": 60,
            "profile": "home", "season": "mixed",
        },
    }


def _ceil_half(x: float) -> float:
    return math.ceil(round(x, 6) * 2) / 2


def load_summary(loads: list[LoadItem], simultaneity_pct: float = SIMULTANEITY_PCT) -> tuple[float, float]:
    """(kWh per day, kW at the same time) of the loads to keep running."""
    daily = sum(l.kwh_day for l in loads)
    peak = sum(l.peak_w for l in loads) / 1000.0 * simultaneity_pct / 100.0
    return daily, peak


def discharge_eff(b: BatteryParams) -> float:
    return math.sqrt(b.roundtrip_pct / 100.0)


def auto_power_kw(capacity_kwh: float, peak_kw: float) -> float:
    """Power when the user gives none: half a kW per kWh, and at least what the loads need."""
    return max(POWER_PER_KWH * capacity_kwh, _ceil_half(peak_kw))


def needed_capacity_kwh(daily_kwh: float, days: float, b: BatteryParams) -> float:
    """Nominal capacity (kWh) that keeps the loads for `days` days with no sun. With no reserve (0 %) the battery
    is counted as full."""
    if daily_kwh <= 0:
        return 0.0
    basis = (b.reserve_pct if b.reserve_pct > 0 else 100.0) / 100.0
    return daily_kwh * days / (discharge_eff(b) * (b.usable_pct / 100.0) * basis)


def cost(capacity_kwh: float, b: BatteryParams) -> dict:
    capex = capacity_kwh * b.cost_per_kwh + (b.cost_fixed if capacity_kwh > 0 else 0.0)
    return {"capex": round(capex, 2), "investment": round(max(capex - b.subsidy_eur, 0.0), 2)}


def evaluate(daily_kwh: float, peak_kw: float, capacity_kwh: float, power_kw: float | None, b: BatteryParams,
             target_days: float) -> dict:
    """Autonomy and checks of one battery size for the given loads."""
    eta = discharge_eff(b)
    usable = capacity_kwh * b.usable_pct / 100.0
    guaranteed = usable * b.reserve_pct / 100.0
    power_auto = power_kw is None
    power = auto_power_kw(capacity_kwh, peak_kw) if power_auto else power_kw
    days_full = usable * eta / daily_kwh if daily_kwh > 0 else None
    days_guaranteed = guaranteed * eta / daily_kwh if daily_kwh > 0 else None
    days = days_guaranteed if b.reserve_pct > 0 else days_full  # what counts against the target
    return {
        "capacity_kwh": round(capacity_kwh, 2),
        "power_kw": round(power, 2),
        "power_auto": power_auto,
        "usable_kwh": round(usable, 2),
        "guaranteed_kwh": round(guaranteed, 2),
        "days_full": None if days_full is None else round(days_full, 2),
        "days_guaranteed": None if days_guaranteed is None else round(days_guaranteed, 2),
        "capacity_ok": bool(daily_kwh > 0 and days is not None and days >= target_days - 1e-9),
        "power_ok": bool(peak_kw <= power + 1e-9),
        **cost(capacity_kwh, b),
    }


def autonomy(req: AutonomyRequest) -> dict:
    b = req.battery
    daily, peak = load_summary(req.loads, req.simultaneity_pct)
    needed = _ceil_half(needed_capacity_kwh(daily, req.target_days, b))
    result = {
        "daily_kwh": round(daily, 2),
        "peak_kw": round(peak, 2),
        "target_days": req.target_days,
        "needed_capacity_kwh": needed,
        "needed_power_kw": _ceil_half(peak),
        "discharge_eff_pct": round(100 * discharge_eff(b), 1),
        "battery": evaluate(daily, peak, b.capacity_kwh, b.power_kw, b, req.target_days),
        "cards": proposals(daily, peak, b, req.target_days, req.kwp),
    }
    return result


def proposals(daily: float, peak: float, b: BatteryParams, target_days: float, kwp: float | None) -> list[dict]:
    """Ready-made sizes as cards. The settings the user gave (efficiency, reserve, costs, a typed power) apply to
    all of them; a card only decides the capacity (and the automatic power)."""
    out = []
    if daily > 0:
        days_list = sorted({*DAYS_CARDS, round(target_days, 2)})
        for d in days_list:
            cap = _ceil_half(needed_capacity_kwh(daily, d, b))
            out.append({"key": f"days_{d:g}", "kind": "days", "days": d,
                        **evaluate(daily, peak, cap, b.power_kw, b, d)})
    if kwp and kwp > 0:
        cap = max(MIN_CARD_KWH, _ceil_half(kwp * PER_KWP_KWH))
        out.append({"key": "per_kwp", "kind": "per_kwp", **evaluate(daily, peak, cap, b.power_kw, b, target_days)})
    out.append({"key": "manual", "kind": "manual", **evaluate(daily, peak, b.capacity_kwh, b.power_kw, b, target_days)})
    return out
