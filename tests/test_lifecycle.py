"""The app stops when its browser is closed (backend/lifecycle.py)."""
from fastapi.testclient import TestClient

from backend import lifecycle
from backend.lifecycle import BYE_GRACE_S, IDLE_LIMIT_S, Pages
from backend.main import app

client = TestClient(app)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def run(pages, clock, seconds, step=1.0):
    """Advance time with a check every `step` s, like the watch thread; True once it says stop."""
    end = clock.t + seconds
    while clock.t < end:
        clock.t += step
        if pages.should_stop():
            return True
    return False


def test_closing_the_browser_stops_after_the_grace():
    clock = Clock()
    pages = Pages(clock)
    pages.seen("a", "hello")
    assert not run(pages, clock, 60)
    pages.seen("a", "bye")
    assert not run(pages, clock, BYE_GRACE_S - 2)
    assert run(pages, clock, 3)


def test_reload_does_not_stop():
    clock = Clock()
    pages = Pages(clock)
    pages.seen("a", "hello")
    pages.seen("a", "bye")
    assert not run(pages, clock, 2)
    pages.seen("b", "hello")  # the reloaded page
    assert not run(pages, clock, 25)


def test_another_open_tab_keeps_it_running():
    clock = Clock()
    pages = Pages(clock)
    pages.seen("a", "hello")
    pages.seen("b", "hello")
    pages.seen("a", "bye")
    for _ in range(10):  # b pings every 30 s
        assert not run(pages, clock, 30)
        pages.seen("b", "ping")


def test_silent_pages_stop_after_the_idle_limit():
    clock = Clock()
    pages = Pages(clock)
    pages.seen("a", "hello")  # e.g. the browser crashed: no bye
    assert not run(pages, clock, IDLE_LIMIT_S - 5)
    assert run(pages, clock, 10)


def test_no_page_at_all_stops_after_the_idle_limit():
    clock = Clock()
    pages = Pages(clock)
    assert not run(pages, clock, IDLE_LIMIT_S - 5)
    assert run(pages, clock, 10)


def test_sleep_of_the_computer_gives_pages_time():
    clock = Clock()
    pages = Pages(clock)
    pages.seen("a", "hello")
    assert not run(pages, clock, 5)
    clock.t += 3600  # an hour of sleep between two checks
    assert not pages.should_stop()
    assert not run(pages, clock, 20)
    pages.seen("a", "ping")
    assert not run(pages, clock, 25)


def test_routes_answer_and_never_stop_without_the_launcher(monkeypatch):
    monkeypatch.setattr(lifecycle, "pages", Pages())
    for event in ("hello", "ping", "bye"):
        r = client.post(f"/api/lifecycle/{event}?page=test-page")
        assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.post("/api/lifecycle/other?page=x").status_code == 422
    assert client.post("/api/lifecycle/ping").status_code == 422
    assert client.get("/api/health").json() == {"ok": True}


def test_a_taken_port_is_told_to_the_user(monkeypatch):
    import socket
    import sys
    import webbrowser

    blocker = socket.socket()
    if sys.platform == "win32":
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    port = blocker.getsockname()[1]
    told, opened = [], []
    monkeypatch.setattr(lifecycle, "PORT", port)
    monkeypatch.setattr(lifecycle, "URL", f"http://127.0.0.1:{port}/")
    monkeypatch.setattr(lifecycle, "pages", Pages())
    monkeypatch.setattr(lifecycle, "tell", told.append)
    monkeypatch.setattr(lifecycle, "open_browser_when_ready", lambda: None)
    monkeypatch.setattr(webbrowser, "open", opened.append)
    try:
        lifecycle.main()
    finally:
        blocker.close()
    assert len(told) == 1 and "δεν ξεκίνησε" in told[0]
    assert not opened
