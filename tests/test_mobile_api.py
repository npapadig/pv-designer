"""Phone access (stream kinito-api): password, token, lockout. Fake data only, never the real data/."""
import pytest
from fastapi.testclient import TestClient

from backend import mobile, settings
from backend.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fake_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "SETTINGS_FILE", tmp_path / "settings.json")
    mobile._failures.clear()
    yield


def enable(password="kodikos1"):
    settings.save_mobile({"mobile_enabled": True, "mobile_password_hash": mobile.hash_password(password)})


def login(password="kodikos1"):
    return client.post("/api/m/login", json={"password": password})


def test_status_without_setup():
    assert client.get("/api/m/status").json() == {"enabled": False, "needs_password": True}


def test_login_refused_while_disabled():
    assert login().status_code == 403


def test_password_is_stored_only_as_hash():
    enable()
    text = settings.SETTINGS_FILE.read_text(encoding="utf-8")
    assert "kodikos1" not in text and "scrypt$" in text
    assert client.get("/api/m/status").json() == {"enabled": True, "needs_password": False}


def test_login_gives_working_token_and_logout_revokes_it():
    enable()
    token = login().json()["token"]
    assert "kodikos1" not in settings.SETTINGS_FILE.read_text(encoding="utf-8")
    assert token not in settings.SETTINGS_FILE.read_text(encoding="utf-8")  # only its hash is kept
    h = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/m/logout", headers=h).json() == {"ok": True}
    assert client.post("/api/m/logout", headers=h).status_code == 401


def test_protected_route_needs_token():
    enable()
    assert client.post("/api/m/logout").status_code == 401
    assert client.post("/api/m/logout", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_wrong_password_and_lockout(monkeypatch):
    enable()
    clock = [1000.0]
    monkeypatch.setattr(mobile, "_now", lambda: clock[0])
    for _ in range(mobile.MAX_FAILURES):
        assert login("lathos").status_code == 401
    assert login().status_code == 429  # even the right password waits
    clock[0] += mobile.LOCK_SECONDS + 1
    assert login().status_code == 200


def test_token_expires(monkeypatch):
    enable()
    clock = [1000.0]
    monkeypatch.setattr(mobile, "_now", lambda: clock[0])
    token = login().json()["token"]
    assert mobile.token_valid(token)
    clock[0] += (mobile.TOKEN_DAYS + 1) * 86400
    assert not mobile.token_valid(token)


def test_settings_endpoint_never_shows_mobile_secrets():
    enable()
    login()
    body = client.get("/api/settings").json()
    assert set(body) == {"google_maps_key"}
    assert set(client.put("/api/settings", json={"google_maps_key": "k"}).json()) == {"google_maps_key"}
    assert settings.load_mobile()["mobile_password_hash"]  # a settings save keeps the mobile fields


# ---------- Step 2: only the computer itself reaches the rest ----------
LAN = TestClient(app, client=("192.168.1.50", 50000))


@pytest.mark.parametrize("method,path", [
    ("get", "/api/projects"), ("get", "/api/settings"), ("put", "/api/settings"),
    ("delete", "/api/projects/" + "a" * 32), ("post", "/api/report"), ("get", "/api/health"),
    ("post", "/api/lifecycle/bye?page=x"), ("get", "/"), ("get", "/index.html"), ("get", "/app.js"),
    ("get", "/api/m-evil"), ("get", "/docs"), ("get", "/openapi.json"),
])
def test_foreign_sender_is_refused_outside_mobile(method, path):
    assert getattr(LAN, method)(path).status_code == 403


def test_foreign_sender_reaches_mobile_and_version():
    assert LAN.get("/api/version").status_code == 200
    assert LAN.get("/api/m/status").status_code == 200
    assert LAN.get("/m/").status_code != 403
    assert LAN.get("/m/nothing-here.js").status_code != 403  # 404 is fine: it passed the gate


def test_ipv6_loopback_and_local_pass():
    for host in ("127.0.0.1", "::1"):
        assert TestClient(app, client=(host, 1)).get("/api/projects").status_code == 200


def test_path_tricks_do_not_open_the_gate():
    for path in ("/m/../api/projects", "/m/%2e%2e/api/projects", "/api/m/../projects"):
        r = LAN.get(path)
        assert r.status_code in (403, 404) and r.status_code != 200
