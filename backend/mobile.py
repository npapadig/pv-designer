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
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import settings

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
