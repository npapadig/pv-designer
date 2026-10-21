import pytest

from backend import finance
from backend.finance import FinanceParams
from tests.test_api import client


def base(**kw):
    return FinanceParams(**{"kwp": 10.0, "annual_kwh": 15000.0, **kw})


def test_typical_greek_home_pays_back():
    res = finance.analyse(base())
    assert res["capex"] == 11000
    assert len(res["years"]) == 25
    # A 10 kWp system at 1500 kWh/kWp in Greece usually pays back in 4-10 years.
    assert 4 < res["payback_years"] < 10
    assert res["npv"] > 0
    assert 8 < res["irr_pct"] < 25
    assert 0.03 < res["lcoe"] < 0.10
    assert res["discounted_payback_years"] > res["payback_years"]


def test_cash_flow_adds_up():
    res = finance.analyse(base())
    y1 = res["years"][0]
    assert y1["production_kwh"] == 15000
    assert y1["self_kwh"] == 6000
    assert y1["savings"] == pytest.approx(6000 * 0.20)
    assert y1["export_income"] == pytest.approx(9000 * 0.07)
    assert y1["net"] == pytest.approx(1200 + 630 - 120)
    assert res["years"][11]["replacement"] == 1200
    assert res["years"][-1]["cumulative"] == pytest.approx(res["total_net"] - res["investment"], abs=0.1)
    assert res["years"][1]["production_kwh"] == round(15000 * 0.995)


def test_irr_makes_npv_zero():
    res = finance.analyse(base())
    flows = [-res["investment"]] + [y["net"] for y in res["years"]]
    assert finance._npv(res["irr_pct"] / 100, flows) == pytest.approx(0, abs=20)  # IRR is rounded to 0.01 %


def test_schemes_rank_as_expected():
    selfonly = finance.analyse(base(scheme="self"))["npv"]
    billing = finance.analyse(base(scheme="net_billing"))["npv"]
    metering = finance.analyse(base(scheme="net_metering"))["npv"]
    assert selfonly < billing < metering


def test_net_metering_capped_by_consumption():
    res = finance.analyse(base(scheme="net_metering", annual_consumption_kwh=8000))
    y1 = res["years"][0]
    # 6000 kWh used directly, only 2000 more can be offset.
    assert y1["export_income"] == pytest.approx(2000 * 0.16)


def test_subsidy_and_no_payback():
    assert finance.analyse(base(subsidy_eur=11000))["payback_years"] == 0
    res = finance.analyse(base(capex_per_kwp=10000, scheme="self"))
    assert res["payback_years"] is None
    assert res["npv"] < 0


def test_needs_production():
    with pytest.raises(ValueError):
        finance.analyse(base(annual_kwh=0))


def test_finance_endpoint():
    r = client.post("/api/finance", json={"kwp": 5, "annual_kwh": 7500, "scheme": "net_metering"})
    assert r.status_code == 200
    assert r.json()["payback_years"] > 0
    assert client.post("/api/finance", json={"kwp": 5, "annual_kwh": 7500, "scheme": "x"}).status_code == 422


def test_finance_appears_in_pdf_report():
    from backend import report
    from tests.test_report import make_project, rendered_sections

    res = finance.analyse(base())
    block = res["report"]
    assert block["summary"][0] == ["Κόστος συστήματος", "11.000 €"]
    assert len(block["tables"][0]["rows"]) == 25
    project = make_project(finance=res)
    assert len(rendered_sections(project)) == len(rendered_sections(make_project())) + 1
    assert report.build_pdf(project, imagery=False)[:4] == b"%PDF"
