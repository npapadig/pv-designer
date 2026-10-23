"""Read-only access from the phone (streams kinito-api / kinito-ui).

The phone app (frontend/m/) talks to /api/m/*. Everything here is read-only: projects and their PDFs.
Security: the password is kept only as a scrypt hash, a login gives a random token (only its hash is
stored, valid 30 days), wrong passwords lock the sender out for a minute, and a middleware (below)
lets any non-loopback sender reach only /m/*, /api/m/* and /api/version.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import socket
import threading
import time
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import appendix_i, lifecycle, plan_drawing, report, settings, single_line, storage, tech_description

TOKEN_DAYS = 30
MAX_FAILURES = 5
LOCK_SECONDS = 60
MIN_PASSWORD = 6

router = APIRouter(prefix="/api/m")
_now = time.time  # replaced in tests
_lock = threading.Lock()
_failures: dict[str, list[float]] = {}  # sender -> [wrong attempts, locked until]


# ---------- Password and tokens ----------
def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        again = hash_password(password, bytes.fromhex(salt)).split("$")[2]
    except ValueError:
        return False
    return hmac.compare_digest(again, digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_token() -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    tokens = {h: exp for h, exp in settings.load_mobile()["mobile_tokens"].items() if exp > now}
    tokens[_token_hash(token)] = now + TOKEN_DAYS * 86400
    settings.save_mobile({"mobile_tokens": tokens})
    return token


def token_valid(token: str) -> bool:
    exp = settings.load_mobile()["mobile_tokens"].get(_token_hash(token))
    return bool(exp and exp > _now())


def revoke_token(token: str) -> None:
    tokens = settings.load_mobile()["mobile_tokens"]
    if tokens.pop(_token_hash(token), None) is not None:
        settings.save_mobile({"mobile_tokens": tokens})


def enabled() -> bool:
    m = settings.load_mobile()
    return bool(m["mobile_enabled"] and m["mobile_password_hash"])


def _bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def require_token(request: Request) -> str:
    token = _bearer(request)
    if not enabled() or not token or not token_valid(token):
        raise HTTPException(401, "Συνδέσου ξανά με τον κωδικό σου.")
    return token


def _sender(request: Request) -> str:
    return request.client.host if request.client else "?"


# ---------- Login ----------
class LoginRequest(BaseModel):
    password: str = Field(..., max_length=200)


@router.get("/status")
def status():
    """For the login screen; needs no token."""
    m = settings.load_mobile()
    return {"enabled": enabled(), "needs_password": not m["mobile_password_hash"]}


@router.post("/login")
def login(req: LoginRequest, request: Request):
    if not enabled():
        raise HTTPException(403, "Η πρόσβαση από το κινητό δεν είναι ενεργή.")
    who, now = _sender(request), _now()
    with _lock:
        count, locked_until = _failures.get(who, [0, 0.0])
        if locked_until > now:
            raise HTTPException(429, f"Πολλές λάθος προσπάθειες. Δοκίμασε ξανά σε {int(locked_until - now) + 1} δευτ.")
        if check_password(req.password, settings.load_mobile()["mobile_password_hash"]):
            _failures.pop(who, None)
        else:
            count += 1
            _failures[who] = [0, now + LOCK_SECONDS] if count >= MAX_FAILURES else [count, 0.0]
            raise HTTPException(401, "Λάθος κωδικός.")
    return {"token": issue_token()}


@router.post("/logout")
def logout(token: str = Depends(require_token)):
    revoke_token(token)
    return {"ok": True}



# ---------- Projects and documents (read-only) ----------
def _project(project_id: str) -> dict:
    try:
        return storage.get_project(project_id)
    except KeyError:
        raise HTTPException(404, "Το έργο δεν βρέθηκε.")


def _electrical_ready(project: dict) -> bool:
    d = (project.get("electrical") or {}).get("design")
    return bool(d and d.get("per_inverter"))


def _has_layout(project: dict) -> bool:
    return bool(project.get("areas") or (project.get("layout") or {}).get("panels"))


def _summary(energy: dict | None) -> dict | None:
    """The numbers of the energy result, without the long monthly/hourly tables."""
    if not energy:
        return None
    return {k: v for k, v in energy.items() if isinstance(v, (int, float, str, bool)) or v is None}


@router.get("/projects")
def projects(_: str = Depends(require_token)):
    out = []
    for p in storage.list_projects():
        try:
            full = storage.get_project(p["id"])
        except KeyError:
            continue
        layout = full.get("layout") or {}
        out.append({"id": p["id"], "name": p["name"], "updated": p["updated_at"], "kwp": layout.get("kwp"),
                    "panels": layout.get("count"), "address": p["address"],
                    "client": (full.get("report_info") or {}).get("client", "")})
    return out


@router.get("/projects/{project_id}")
def project(project_id: str, _: str = Depends(require_token)):
    p = _project(project_id)
    return {"id": p["id"], "name": p.get("name", ""), "updated": p.get("updated_at", ""),
            "areas": p.get("areas") or [], "keepouts": p.get("keepouts") or [],
            "layout": p.get("layout") or {}, "settings": p.get("settings") or {},
            "report_info": p.get("report_info") or {}, "energy": _summary(p.get("energy")),
            "electrical_ready": _electrical_ready(p)}


DOCUMENTS = (  # kind, title, needs the electrical design
    ("report", "Αναφορά", False), ("plan", "Κάτοψη", False), ("single-line", "Μονογραμμικό", True),
    ("tech", "Τεχνική περιγραφή", True), ("appendix-i", "Παράρτημα Ι", True),
)
NO_DESIGN = "Λείπει ο σχεδιασμός inverter (βήμα «Inverter»)."
NO_LAYOUT = "Δεν έχει σχεδιαστεί περιοχή με πάνελ."


def _unavailable(project: dict, needs_electrical: bool) -> str:
    if needs_electrical:
        return "" if _electrical_ready(project) else NO_DESIGN
    return "" if _has_layout(project) else NO_LAYOUT


@router.get("/projects/{project_id}/documents")
def documents(project_id: str, _: str = Depends(require_token)):
    p = _project(project_id)
    out = []
    for kind, title, needs_electrical in DOCUMENTS:
        why = _unavailable(p, needs_electrical)
        out.append({"kind": kind, "title": title, "available": not why, "reason": why})
    return out


@router.get("/projects/{project_id}/documents/{kind}")
def document(project_id: str, kind: str, lang: str = "el", _: str = Depends(require_token)):
    p = _project(project_id)
    spec = next((d for d in DOCUMENTS if d[0] == kind), None)
    if not spec:
        raise HTTPException(404, "Άγνωστο έγγραφο.")
    why = _unavailable(p, spec[2])
    if why:
        raise HTTPException(400, why)
    lang = lang if lang in ("el", "en") else "el"
    try:
        if kind == "report":
            pdf, name = report.build_pdf(p, lang=lang), report.filename(p, lang)
        elif kind == "plan":
            pdf, name = plan_drawing.build_plan_pdf(p, lang, "a4"), plan_drawing.filename(p, lang)
        elif kind == "single-line":
            pdf, name = single_line.build_single_line_pdf(p, lang), single_line.filename(p, lang)
        elif kind == "tech":
            pdf, name = tech_description.build_tech_description_pdf(p, lang), tech_description.filename(p, lang)
        else:
            pdf, name = appendix_i.build_appendix_i_pdf(p), appendix_i.filename(p)
    except ValueError as e:
        raise HTTPException(400, str(e))
    disposition = f"inline; filename={kind}.pdf; filename*=UTF-8''" + quote(name)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": disposition})


# ---------- Setup from the computer (loopback only) ----------
def loopback_only(request: Request) -> None:
    host = request.client.host if request.client else ""
    if host not in LOOPBACK:
        raise HTTPException(403, "Η ρύθμιση γίνεται μόνο από τον υπολογιστή.")


def lan_addresses() -> list[str]:
    """Addresses of this computer on the local network (the UDP "connect" sends nothing)."""
    found: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    return list(dict.fromkeys(a for a in found if not a.startswith(("127.", "169.254.", "0."))))


def listening_on_network() -> bool:
    return lifecycle.listening_host != lifecycle.HOST


@router.get("/info", dependencies=[Depends(loopback_only)])
def info():
    m = settings.load_mobile()
    on = enabled()
    return {"enabled": on, "password_set": bool(m["mobile_password_hash"]),
            "urls": [f"http://{a}:{lifecycle.PORT}/m/" for a in lan_addresses()] if on else [],
            "restart_needed": on != listening_on_network()}


class SetupRequest(BaseModel):
    enabled: bool
    password: str | None = Field(None, max_length=200)


@router.post("/setup", dependencies=[Depends(loopback_only)])
def setup(req: SetupRequest):
    changes: dict = {"mobile_enabled": req.enabled}
    if req.password is not None:
        if len(req.password) < MIN_PASSWORD:
            raise HTTPException(400, f"Ο κωδικός πρέπει να έχει τουλάχιστον {MIN_PASSWORD} χαρακτήρες.")
        # A new password logs every phone out.
        changes.update(mobile_password_hash=hash_password(req.password), mobile_tokens={})
    elif req.enabled and not settings.load_mobile()["mobile_password_hash"]:
        raise HTTPException(400, "Διάλεξε πρώτα έναν κωδικό για το κινητό.")
    if not req.enabled:
        changes["mobile_tokens"] = {}
    settings.save_mobile(changes)
    with _lock:
        _failures.clear()
    return info()


# ---------- Who may reach what ----------
LOOPBACK = {"127.0.0.1", "::1", "testclient"}  # "testclient" is Starlette's TestClient; no socket gives that name
OPEN_TO_NETWORK = ("/m/", "/api/m/")


def allowed_for_network(path: str) -> bool:
    return path in ("/m", "/api/version") or path.startswith(OPEN_TO_NETWORK)


async def loopback_only_outside_mobile(request: Request, call_next):
    """Anyone not on this computer sees only the phone app: everything else (delete a project, the
    Google key, ...) is for the computer itself."""
    host = request.client.host if request.client else ""
    if host not in LOOPBACK and not allowed_for_network(request.url.path):
        return JSONResponse({"detail": "Αυτή η διεύθυνση είναι μόνο για τον υπολογιστή."}, status_code=403)
    return await call_next(request)
