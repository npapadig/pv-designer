"""Start and stop of the app when it runs from the launcher (start_windows.bat, start_mac_linux.sh).

`python -m backend.lifecycle` starts the server (with pythonw on Windows: no console window), opens
the browser only once the server answers, and stops the server when the browser is closed. If the
app already runs, it just opens the browser.

Closing is noticed from the pages themselves (frontend/home.js): every open page says "hello",
"ping"s every 30 s and says "bye" (sendBeacon) when it goes away. The server stops ~10 s after a
"bye" when no page is left (a reload says "hello" again well within that), and as a safety net after
3 minutes without any news (Chrome may ping from hidden tabs only once a minute). The routes are
always there, but only the launcher arms the stop, so tests and a plain `uvicorn` run never stop.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Query

from . import settings

HOST, PORT = "127.0.0.1", int(os.environ.get("PV_DESIGNER_PORT") or 8000)  # another port only for tests
URL = f"http://{HOST}:{PORT}/"
listening_host = HOST  # what the running server really listens on (set in main())
BYE_GRACE_S = 10
IDLE_LIMIT_S = 180
SLEEP_GAP_S = 30  # a longer pause between two checks means the computer slept
ROOT_DIR = Path(__file__).resolve().parent.parent
# Outside the project folder, so a git checkout stays clean.
LOG_FILE = Path(tempfile.gettempdir()) / "pv-designer-server.log"


class Pages:
    """The open browser pages, and whether the app may stop. Times come from `clock` (seconds)."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.restart()

    def restart(self):
        with self.lock:
            self.pages: dict[str, float] = {}  # page id -> last news from it
            self.last_heard = self.last_check = self.clock()
            self.last_bye: float | None = None

    def seen(self, page: str, event: str):
        with self.lock:
            now = self.last_heard = self.clock()
            if event == "bye":
                self.pages.pop(page, None)
                self.last_bye = now
            else:
                self.pages[page] = now

    def should_stop(self) -> bool:
        with self.lock:
            now = self.clock()
            if now - self.last_check > SLEEP_GAP_S:
                # After sleep the pages could not ping: start their time again.
                self.last_heard = now
                self.pages = dict.fromkeys(self.pages, now)
                if self.last_bye is not None:
                    self.last_bye = now
            self.last_check = now
            self.pages = {p: t for p, t in self.pages.items() if now - t <= IDLE_LIMIT_S}
            if self.pages:
                return False
            if self.last_bye is not None and now - self.last_bye >= BYE_GRACE_S:
                return True
            return now - self.last_heard >= IDLE_LIMIT_S


pages = Pages()
router = APIRouter()


@router.post("/api/lifecycle/{event}", include_in_schema=False)
def lifecycle_event(event: Literal["hello", "ping", "bye"], page: str = Query(..., min_length=1, max_length=64)):
    pages.seen(page, event)
    return {"ok": True}


def watch(stop, every: float = 1.0):
    """Call `stop()` (once) when no browser page is left."""
    def loop():
        while not pages.should_stop():
            time.sleep(every)
        stop()
    pages.restart()
    threading.Thread(target=loop, name="pv-designer-watch", daemon=True).start()


# ---------- Launcher ----------
def listen_host() -> str:
    """The whole network only when the phone app is on (and has a password); otherwise this computer only."""
    m = settings.load_mobile()
    return "0.0.0.0" if m["mobile_enabled"] and m["mobile_password_hash"] else HOST


def server_answers(timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"{URL}api/health", timeout=timeout) as r:
            return json.load(r).get("ok") is True
    except Exception:
        return False


def open_browser_when_ready(limit_s: float = 90):
    end = time.monotonic() + limit_s
    while time.monotonic() < end:
        if server_answers():
            webbrowser.open(URL)
            return
        time.sleep(0.3)


def tell(text: str):
    """A message for the user, who has no console window with pythonw."""
    print(text, flush=True)
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, "PV Designer", 0x10)


def main():
    os.chdir(ROOT_DIR)
    if server_answers():
        webbrowser.open(URL)
        return
    if sys.stdout is None or sys.stderr is None:  # pythonw: keep the server's messages in a file
        sys.stdout = sys.stderr = open(LOG_FILE, "w", encoding="utf-8", buffering=1)
    global listening_host
    server = None
    try:
        import uvicorn

        from backend.main import app
        listening_host = listen_host()
        server = uvicorn.Server(uvicorn.Config(app, host=listening_host, port=PORT, access_log=False))
        watch(lambda: setattr(server, "should_exit", True))
        threading.Thread(target=open_browser_when_ready, daemon=True).start()
        server.run()
    except BaseException:  # uvicorn exits with SystemExit when the port is taken
        traceback.print_exc()
    if server is None or not server.started:
        tell(f"Η εφαρμογή δεν ξεκίνησε. Ίσως η θύρα {PORT} χρησιμοποιείται από άλλο πρόγραμμα: κάνε επανεκκίνηση "
             f"στον υπολογιστή και δοκίμασε ξανά.\n\nΛεπτομέρειες: {LOG_FILE}")


if __name__ == "__main__":
    # Run inside the imported module, so the routes and the watch share one `pages`.
    from backend import lifecycle
    lifecycle.main()
