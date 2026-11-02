"""The real battery catalog (backend/catalog/batteries.json) is plausible and served by the API."""
from fastapi.testclient import TestClient

from backend import battery
from backend.main import app

client = TestClient(app)


def test_catalog_loads_and_is_big_enough():
    cat = battery.load_catalog()
    assert len(cat) >= 10


def test_unique_names_and_sources():
    cat = battery.load_catalog()
    names = [b.name for b in cat]
    assert len(names) == len(set(names))
    assert all(b.source.startswith("http") for b in cat)


def test_values_are_plausible():
    for b in battery.load_catalog():
        assert 0.1 <= b.power_kw / b.capacity_kwh <= 2.5, b.name
        assert b.usable_kwh >= 0.8 * b.capacity_kwh, b.name
        if b.roundtrip_pct is not None:
            assert 80 <= b.roundtrip_pct <= 99, b.name


def test_api_returns_the_same_entries():
    cat = battery.load_catalog()
    r = client.get("/api/battery/presets")
    assert r.status_code == 200
    assert r.json()["catalog"] == [b.model_dump() for b in cat]
