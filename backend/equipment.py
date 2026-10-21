"""Inverter library.

Generic models with datasheet values typical of current string inverters on the
market. The user can also enter the values of any real model in the app.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class Inverter(BaseModel):
    name: str = "Δικός μου inverter"
    phases: int = Field(3, ge=1, le=3)
    pac_w: float = Field(..., gt=0, description="rated AC power")
    pdc_max_w: float = Field(..., gt=0, description="maximum PV (DC) power")
    vdc_max: float = Field(..., gt=0, description="maximum DC input voltage")
    v_mppt_min: float = Field(..., gt=0)
    v_mppt_max: float = Field(..., gt=0)
    v_start: float = Field(0, ge=0)
    n_mppt: int = Field(..., ge=1, le=20)
    strings_per_mppt: int = Field(..., ge=1, le=10)
    i_max_mppt: float = Field(..., gt=0, description="maximum input current per MPPT")
    isc_max_mppt: float = Field(..., gt=0, description="maximum short-circuit current per MPPT")
    eff_pct: float = Field(97.5, gt=50, le=100, description="European weighted efficiency")


def _inv(name, phases, pac_kw, vdc_max, v_min, v_max, v_start, n_mppt, spm, i_max, isc_max, eff, dc_factor=1.5):
    return Inverter(
        name=name, phases=phases, pac_w=pac_kw * 1000, pdc_max_w=pac_kw * 1000 * dc_factor,
        vdc_max=vdc_max, v_mppt_min=v_min, v_mppt_max=v_max, v_start=v_start, n_mppt=n_mppt,
        strings_per_mppt=spm, i_max_mppt=i_max, isc_max_mppt=isc_max, eff_pct=eff,
    )


INVERTERS: list[Inverter] = [
    _inv("Μονοφασικός 3 kW (1 MPPT)", 1, 3, 600, 80, 550, 100, 1, 1, 16, 22, 97.0),
    _inv("Μονοφασικός 4 kW (2 MPPT)", 1, 4, 600, 80, 550, 100, 2, 1, 16, 22, 97.2),
    _inv("Μονοφασικός 5 kW (2 MPPT)", 1, 5, 600, 80, 550, 100, 2, 1, 16, 22, 97.3),
    _inv("Μονοφασικός 6 kW (2 MPPT)", 1, 6, 600, 80, 550, 100, 2, 1, 16, 22, 97.3),
    _inv("Τριφασικός 5 kW (2 MPPT)", 3, 5, 1100, 160, 950, 200, 2, 1, 16, 22, 97.5),
    _inv("Τριφασικός 8 kW (2 MPPT)", 3, 8, 1100, 160, 950, 200, 2, 1, 16, 22, 97.8),
    _inv("Τριφασικός 10 kW (2 MPPT)", 3, 10, 1100, 160, 950, 200, 2, 2, 26, 34, 98.0),
    _inv("Τριφασικός 12 kW (2 MPPT)", 3, 12, 1100, 160, 950, 200, 2, 2, 26, 34, 98.0),
    _inv("Τριφασικός 15 kW (2 MPPT)", 3, 15, 1100, 160, 950, 200, 2, 2, 32, 40, 98.1),
    _inv("Τριφασικός 20 kW (2 MPPT)", 3, 20, 1100, 160, 950, 200, 2, 3, 40, 50, 98.2),
    _inv("Τριφασικός 30 kW (3 MPPT)", 3, 30, 1100, 200, 1000, 250, 3, 2, 32, 40, 98.3),
    _inv("Τριφασικός 50 kW (4 MPPT)", 3, 50, 1100, 200, 1000, 250, 4, 3, 40, 50, 98.4),
    _inv("Τριφασικός 100 kW (10 MPPT)", 3, 100, 1100, 200, 1000, 250, 10, 2, 32, 40, 98.5),
]
