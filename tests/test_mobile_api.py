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



# ---------- Step 3: projects and documents (fake projects in a temp folder) ----------
from backend import mapimage, storage  # noqa: E402
from tests.test_plan_drawing import _design  # noqa: E402
from tests.test_report import make_project  # noqa: E402


@pytest.fixture
def phone(tmp_path, monkeypatch):
    """A logged-in phone client from the Wi-Fi, and three fake projects (never the real data/)."""
    from PIL import Image
    monkeypatch.setattr(storage, "DATA_DIR", tmp_path / "projects")
    monkeypatch.setattr(mapimage, "_native_zoom", lambda c, src, lat, lon: 20)
    monkeypatch.setattr(mapimage, "_fetch_tile", lambda c, src, z, x, y: Image.new("RGB", (256, 256), (80, 110, 70)))
    enable()
    c = TestClient(app, client=("192.168.1.50", 50000))
    c.headers["Authorization"] = "Bearer " + c.post("/api/m/login", json={"password": "kodikos1"}).json()["token"]
    c.full = storage.save_project(make_project(electrical={"design": _design()}))["id"]
    c.plain = storage.save_project(make_project(name="Χωρίς inverter"))["id"]
    c.empty = storage.save_project({"name": "Κενό"})["id"]
    return c


def test_mobile_routes_need_a_token(phone):
    anon = TestClient(app, client=("192.168.1.50", 50000))
    for path in ("/api/m/projects", f"/api/m/projects/{phone.full}", f"/api/m/projects/{phone.full}/documents",
                 f"/api/m/projects/{phone.full}/documents/report"):
        assert anon.get(path).status_code == 401


def test_project_list(phone):
    items = {i["id"]: i for i in phone.get("/api/m/projects").json()}
    assert set(items) == {phone.full, phone.plain, phone.empty}
    item = items[phone.full]
    assert set(item) == {"id", "name", "updated", "kwp", "panels", "address", "client"}
    assert item["client"] == "Γιώργος" and item["address"] == "Ερμού 1, Αθήνα" and item["panels"] > 0


def test_project_detail_is_summary_and_has_no_secrets(phone):
    d = phone.get(f"/api/m/projects/{phone.full}").json()
    assert d["electrical_ready"] is True
    assert phone.get(f"/api/m/projects/{phone.plain}").json()["electrical_ready"] is False
    assert d["areas"] and d["layout"]["panels"] and d["report_info"]["client"] == "Γιώργος"
    assert isinstance(d["energy"]["annual_kwh"], (int, float))
    assert all(not isinstance(v, (list, dict)) for v in d["energy"].values())
    assert "electrical" not in d and "plan" not in d
    assert "scrypt" not in str(d) and "google" not in str(d).lower()


def test_unknown_or_bad_project_id_is_404(phone):
    assert phone.get("/api/m/projects/" + "0" * 32).status_code == 404
    assert phone.get("/api/m/projects/..%2F..%2Fsettings").status_code == 404


def test_document_list_says_why_not(phone):
    full = {d["kind"]: d for d in phone.get(f"/api/m/projects/{phone.full}/documents").json()}
    assert list(full) == ["report", "plan", "single-line", "tech", "appendix-i"]
    assert all(d["available"] and not d["reason"] for d in full.values())
    plain = {d["kind"]: d for d in phone.get(f"/api/m/projects/{phone.plain}/documents").json()}
    assert plain["report"]["available"] and plain["plan"]["available"]
    for k in ("single-line", "tech", "appendix-i"):
        assert not plain[k]["available"] and "inverter" in plain[k]["reason"]
    empty = {d["kind"]: d for d in phone.get(f"/api/m/projects/{phone.empty}/documents").json()}
    assert not empty["report"]["available"] and empty["report"]["reason"]


@pytest.mark.parametrize("kind", ["report", "plan", "single-line", "tech", "appendix-i"])
def test_all_five_pdfs(phone, kind):
    for lang in ("el", "en"):
        r = phone.get(f"/api/m/projects/{phone.full}/documents/{kind}?lang={lang}")
        assert r.status_code == 200 and r.content.startswith(b"%PDF")
        assert r.headers["content-type"] == "application/pdf"


def test_pdf_refused_when_not_available(phone):
    assert phone.get(f"/api/m/projects/{phone.plain}/documents/tech").status_code == 400
    assert phone.get(f"/api/m/projects/{phone.empty}/documents/report").status_code == 400
    assert phone.get(f"/api/m/projects/{phone.full}/documents/nope").status_code == 404


def test_phone_cannot_change_or_delete_anything(phone):
    assert phone.delete(f"/api/projects/{phone.full}").status_code == 403
    assert phone.put(f"/api/projects/{phone.full}", json={"name": "x"}).status_code == 403
    for method in ("post", "put", "delete", "patch"):
        r = getattr(phone, method)(f"/api/m/projects/{phone.full}")
        assert r.status_code in (404, 405)
    assert storage.get_project(phone.full)["name"] == "Σπίτι Αθήνα"


# ---------- Step 4: setup/info from the computer, listening address ----------
from backend import lifecycle  # noqa: E402


def test_setup_and_info_are_for_the_computer_only(phone):
    assert phone.get("/api/m/info").status_code == 403
    assert phone.post("/api/m/setup", json={"enabled": False}).status_code == 403
    assert settings.load_mobile()["mobile_enabled"] is True  # untouched


def test_setup_needs_a_password_before_enabling():
    assert client.post("/api/m/setup", json={"enabled": True}).status_code == 400
    assert client.post("/api/m/setup", json={"enabled": True, "password": "123"}).status_code == 400
    assert client.get("/api/m/info").json() == {"enabled": False, "password_set": False, "urls": [],
                                                "restart_needed": False}


def test_setup_enables_and_asks_for_restart(monkeypatch):
    monkeypatch.setattr(lifecycle, "listening_host", lifecycle.HOST)
    monkeypatch.setattr(mobile, "lan_addresses", lambda: ["192.168.1.20"])
    body = client.post("/api/m/setup", json={"enabled": True, "password": "kodikos1"}).json()
    assert body["enabled"] and body["password_set"] and body["restart_needed"] is True
    assert body["urls"] == [f"http://192.168.1.20:{lifecycle.PORT}/m/"]
    assert login().status_code == 200
    monkeypatch.setattr(lifecycle, "listening_host", "0.0.0.0")  # after the restart
    assert client.get("/api/m/info").json()["restart_needed"] is False
    # turning it off logs the phones out and asks for a restart again
    token = login().json()["token"]
    off = client.post("/api/m/setup", json={"enabled": False}).json()
    assert off["enabled"] is False and off["restart_needed"] is True and off["urls"] == []
    assert not mobile.token_valid(token) and login().status_code == 403


def test_new_password_logs_phones_out():
    client.post("/api/m/setup", json={"enabled": True, "password": "kodikos1"})
    token = login().json()["token"]
    client.post("/api/m/setup", json={"enabled": True, "password": "neos-kodikos"})
    assert not mobile.token_valid(token)
    assert login().status_code == 401 and login("neos-kodikos").status_code == 200
    assert "neos-kodikos" not in settings.SETTINGS_FILE.read_text(encoding="utf-8")


def test_server_listens_on_the_network_only_when_mobile_is_on():
    assert lifecycle.listen_host() == "127.0.0.1"
    settings.save_mobile({"mobile_enabled": True})  # no password yet: still closed
    assert lifecycle.listen_host() == "127.0.0.1"
    enable()
    assert lifecycle.listen_host() == "0.0.0.0"
    settings.save_mobile({"mobile_enabled": False})
    assert lifecycle.listen_host() == "127.0.0.1"


def test_lan_addresses_are_not_loopback():
    assert all(not a.startswith("127.") for a in mobile.lan_addresses())
