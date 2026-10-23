"""Tests never read or write the owner's real settings (`data/settings.json`): since the phone app (v0.17) the
settings decide on which network address the server listens, so a real setting would change test results."""
import pytest

from backend import lifecycle, settings


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(lifecycle, "listening_host", lifecycle.HOST)  # lifecycle.main() sets it
    yield
