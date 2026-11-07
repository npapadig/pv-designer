"""The floor plan on the map (plan.js): the page has the controls for sizing, turning and fitting it."""
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


def test_plan_controls_are_in_the_page():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    for ident in ("btnPlanScale", "btnPlanFit", "planFitRow", "planFitInfo", "btnPlanFitCancel", "planNudge",
                  "planRot", "planRotNum", "planWidth", "planOpacity", "planLock"):
        assert f'id="{ident}"' in html
    assert html.count('data-what="size"') == 2 and html.count('data-what="rot"') == 2


def test_plan_script_has_handles_and_fit():
    js = (FRONTEND / "plan.js").read_text(encoding="utf-8")
    for part in ("plan-frame", "scaleAbout", "applyFit", "startFit", 'data-c="rot"'):
        assert part in js
    css = (FRONTEND / "home.css").read_text(encoding="utf-8")
    assert ".plan-frame .ph" in css
