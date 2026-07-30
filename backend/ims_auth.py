"""
Adobe IMS authentication for the Nexus backend.

This module replaces the email+password login mechanism with Adobe IMS
(OAuth 2.0 Authorization Code flow). The Client Secret stays server-side:
the browser only ever sees a redirect to Adobe and, on return, an httpOnly
signed session cookie issued by this backend.

Flow (see /api/auth/ims/login and /api/auth/ims/callback below):

    browser -> GET  /api/auth/ims/login
            -> 302  https://ims-na1.adobelogin.com/ims/authorize/v1?...code...
            -> user signs in at Adobe
            -> 302  /api/auth/ims/callback?code=...&state=...
                    backend exchanges code (+client_secret) at /ims/token/v3,
                    fetches /ims/profile/v1, maps the IMS email to the existing
                    onboarding_requests / manager_accounts tables, then sets a
                    signed "nexus_session" cookie and redirects to the frontend.

The endpoint contracts (authorize/v1, token/v3, profile/v1, logout/v1) and the
STAGE/PROD hosts are taken directly from the imslib2.js reference source so the
server-side client is faithful to Adobe's own library.

No new pip dependencies: uses httpx (already required) + the standard library.
"""

import os
import json
import time
import hmac
import base64
import hashlib
import secrets
from contextlib import contextmanager
from typing import Optional
from urllib.parse import urlencode

import httpx
import psycopg2
import psycopg2.extras
from fastapi import APIRouter, Request, HTTPException, Depends
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel

# ── Configuration (from environment / backend .env) ──────────────────────────
IMS_CLIENT_ID     = os.getenv("IMS_CLIENT_ID", "")
IMS_CLIENT_SECRET = os.getenv("IMS_CLIENT_SECRET", "")
# IMS scopes are comma-separated (imslib2 default is "AdobeID"). openid/email/
# profile are required to read the user's email + name from /ims/profile/v1.
IMS_SCOPE         = os.getenv("IMS_SCOPE", "openid,AdobeID,email,profile")
IMS_ENV           = os.getenv("IMS_ENV", "prod").lower()          # "prod" | "stg1"
IMS_REDIRECT_URI  = os.getenv("IMS_REDIRECT_URI", "http://localhost:8000/api/auth/ims/callback")
IMS_LOCALE        = os.getenv("IMS_LOCALE", "en_US")
FRONTEND_URL      = os.getenv("FRONTEND_URL", "http://localhost:5173")
DATABASE_URL      = os.getenv("DATABASE_URL", "postgresql://postgres:nexus123@localhost:5432/nexus")

# Session signing / cookies
SESSION_SECRET    = os.getenv("SESSION_SECRET", "dev-only-change-me-in-production")
SESSION_TTL       = int(os.getenv("SESSION_TTL_SECONDS", str(8 * 3600)))   # 8h default
TX_TTL            = 600                                                     # login handshake cookie: 10 min
SESSION_COOKIE    = "nexus_session"
TX_COOKIE         = "nexus_ims_tx"
# Cookie flags. On localhost both 5173 and 8000 are the same *site*, so
# SameSite=Lax + credentials works for the top-level callback redirect and for
# credentialed fetches from the SPA. Set COOKIE_SECURE=true behind HTTPS.
COOKIE_SECURE     = os.getenv("COOKIE_SECURE", "false").lower() == "true"
COOKIE_SAMESITE   = os.getenv("COOKIE_SAMESITE", "lax")

# Emails (comma-separated) that should always resolve to the Admin persona.
IMS_ADMIN_EMAILS   = {e.strip().lower() for e in os.getenv("IMS_ADMIN_EMAILS",   "").split(",") if e.strip()}
# Emails that should always resolve to the Manager persona (bypass directory check).
IMS_MANAGER_EMAILS = {e.strip().lower() for e in os.getenv("IMS_MANAGER_EMAILS", "").split(",") if e.strip()}

# ── IMS hosts (verified against imslib2 Environment.ts) ───────────────────────
if IMS_ENV == "stg1":
    BASE_URL_ADOBE    = "https://ims-na1-stg1.adobelogin.com"
    BASE_URL_SERVICES = "https://adobeid-na1-stg1.services.adobe.com"
else:
    BASE_URL_ADOBE    = "https://ims-na1.adobelogin.com"
    BASE_URL_SERVICES = "https://adobeid-na1.services.adobe.com"

AUTHORIZE_URL = f"{BASE_URL_ADOBE}/ims/authorize/v1"
TOKEN_URL     = f"{BASE_URL_SERVICES}/ims/token/v3"
PROFILE_URL   = f"{BASE_URL_ADOBE}/ims/profile/v1"
VALIDATE_URL  = f"{BASE_URL_ADOBE}/ims/validate_token/v1"
LOGOUT_URL    = f"{BASE_URL_ADOBE}/ims/logout/v1"

router = APIRouter()

IMS_CONFIGURED = bool(IMS_CLIENT_ID and IMS_CLIENT_SECRET)


# ── DB access (self-contained so this module has no import cycle with main) ───
@contextmanager
def _get_db():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Signed-token helpers (stdlib HMAC; no JWT dependency) ─────────────────────
def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload: dict, ttl: int) -> str:
    """Return a compact `base64url(json).base64url(hmac)` token with an exp."""
    body = dict(payload)
    body["exp"] = int(time.time()) + ttl
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    b = _b64u_encode(raw)
    sig = hmac.new(SESSION_SECRET.encode("utf-8"), b.encode("ascii"), hashlib.sha256).digest()
    return f"{b}.{_b64u_encode(sig)}"


def _verify(token: str) -> Optional[dict]:
    """Verify signature + expiry; return the payload dict or None."""
    if not token or "." not in token:
        return None
    b, sig = token.rsplit(".", 1)
    expected = hmac.new(SESSION_SECRET.encode("utf-8"), b.encode("ascii"), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_b64u_decode(sig), expected):
            return None
        payload = json.loads(_b64u_decode(b))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


# ── PKCE (mirrors imslib2 code-challenge.ts: verifier -> S256 challenge) ──────
def _make_pkce():
    verifier = _b64u_encode(secrets.token_bytes(43))[:43]
    challenge = _b64u_encode(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


# ── Persona classification (shared by IMS + legacy login) ─────────────────────
def classify_persona(doj, capstone_completed: bool):
    """Nexus rule: Experienced if the capstone is complete OR the employee joined
    >= 6 months ago; otherwise New Joiner. Returns (persona, tenure_display).

    `doj` may be a date/datetime, an ISO string, or None. Tenure is display-only."""
    from datetime import date, datetime
    d = None
    if isinstance(doj, datetime):
        d = doj.date()
    elif isinstance(doj, date):
        d = doj
    elif doj:
        try:
            d = date.fromisoformat(str(doj)[:10])
        except Exception:
            d = None
    if d is None:
        # No usable DOJ → fall back to the capstone flag alone.
        return ("exp", "Experienced") if capstone_completed else ("nj", "Week 1")
    today = date.today()
    days = (today - d).days
    months = (today.year - d.year) * 12 + (today.month - d.month) - (1 if today.day < d.day else 0)
    if days >= 365:
        tenure = f"Year {max(1, days // 365)}"
    elif months >= 6:
        tenure = "6+ months"
    else:
        tenure = f"Week {max(1, (days // 7) + 1)}"
    persona = "exp" if (capstone_completed or months >= 6) else "nj"
    return (persona, tenure)


# ── Learning-track resolution — grounds the profile's track in real org data ──
_TRACK_LABELS = {
    "rtcdp": "Real-Time CDP", "analytics": "Adobe Analytics", "ajo": "Adobe Journey Optimizer",
    "cja": "Customer Journey Analytics", "da": "AEP - Data Architect", "de": "AEP - Data Engineer",
    "es": "Engineering Services", "target": "Adobe Target", "marketo": "Marketo Engage",
    "campaign": "Adobe Campaign Classic",
}

def _track_from_focus(text: str):
    """Map a manager's free-text Track Focus (manager_hierarchy) to a track code.
    Mirrors crossskill._journey_role_from_manager_focus but yields a curriculum
    track code, not a journey role. Priority-ordered so specific tokens win."""
    if not text:
        return None
    f = text.lower()
    rules = [
        ("data architect", "da"), ("(da", "da"), (" da ", "da"), ("da)", "da"),
        ("data engineer", "de"), ("de (", "de"), (" de ", "de"), ("de,", "de"),
        ("engineering services", "es"), ("(es", "es"), (" es ", "es"), ("es)", "es"),
        ("aa-sdk", "analytics"), ("web sdk", "analytics"), ("analytics", "analytics"), ("sdk", "analytics"),
        ("journey", "ajo"), ("ajo", "ajo"),
        ("rtcdp", "rtcdp"), ("real-time cdp", "rtcdp"), ("cdp", "rtcdp"),
    ]
    for token, code in rules:
        if token in f:
            return code
    return None

def _resolve_learning_track(manager_name: str, team: str, role: str):
    """Authoritative primary learning track for a learner, grounded in real data.
    Resolution order (the user's rule: 'roles depend on the mgr they report to'):
      1. The learner's manager's Track Focus (manager_hierarchy) — authoritative.
      2. The team string, if it names a track.
      3. The role string, if it names a track.
      4. Default 'rtcdp'.
    Returns (track_code, track_label)."""
    code = None
    # 1) Manager focus (most authoritative)
    if manager_name:
        try:
            with _get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT track_focus FROM manager_hierarchy "
                                "WHERE manager_name ILIKE %s LIMIT 1", (f"%{manager_name}%",))
                    r = cur.fetchone()
            if r and r[0]:
                code = _track_from_focus(r[0])
        except Exception as e:
            print(f"[track-resolve] manager lookup skipped: {e}")
    # 2) Team string, 3) Role string
    if not code:
        code = _track_from_focus(team) or _track_from_focus(role)
    code = code or "rtcdp"
    return code, _TRACK_LABELS.get(code, code.upper())


# ── Role / persona resolution — maps an IMS email to a Nexus role/route ───────
def _resolve_account(email: str, name_hint: str = "") -> dict:
    """
    Decide who this authenticated IMS user is. Priority:
      1. Admin   — email in IMS_ADMIN_EMAILS
      2. Manager — email is a Manager Email for >=1 active employee (derived from
                   the uploaded Excel directory), or a legacy approved manager_account
      3. Employee— being on the HR roster (employee_directory) IS the authorization.
                   No manager approval gate: routes straight to nj/exp by DOJ (or
                   capstone-completed, which promotes early). Manager approval is a
                   separate, later action that only ticks capstone-completed.
      4. Fallback— not in the directory → manual onboarding form, gated by manager
                   approve/decline (the only path that still needs approval).

    Returns {"outcome": "admin"|"approved"|"pending"|"declined"|"onboarding", ...}.
    """
    email_l = (email or "").strip().lower()

    # 1) Platform administrators (configured via IMS_ADMIN_EMAILS)
    if email_l in IMS_ADMIN_EMAILS:
        return {"outcome": "admin", "persona": "admin",
                "profile": {"name": name_hint or email, "email": email, "persona": "admin"}}

    # 1.5) Explicitly designated managers via IMS_MANAGER_EMAILS env var
    if email_l in IMS_MANAGER_EMAILS:
        return {"outcome": "approved", "persona": "mgr",
                "profile": {"name": name_hint or email, "email": email, "persona": "mgr",
                            "team": None, "manager_email": None}}

    # Read the directory once: the caller's own row + whether they manage anyone.
    dir_row = None
    is_manager = False
    try:
        with _get_db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM employee_directory WHERE email=%s", (email_l,))
                dir_row = cur.fetchone()
                cur.execute("SELECT 1 FROM employee_directory WHERE LOWER(manager_email)=%s AND is_active=TRUE LIMIT 1",
                            (email_l,))
                is_manager = cur.fetchone() is not None
    except Exception:
        dir_row, is_manager = None, False

    # A departed employee (soft-deleted, and not a manager) is denied access.
    if dir_row is not None and not dir_row.get("is_active", True) and not is_manager:
        return {"outcome": "declined", "reason": "inactive"}

    # 2a) Manager — derived from the Excel Manager Email column.
    if is_manager:
        name = ((f"{dir_row.get('first_name') or ''} {dir_row.get('last_name') or ''}".strip())
                if dir_row else "") or name_hint or email
        return {"outcome": "approved", "persona": "mgr",
                "profile": {"name": name, "email": email,
                            "team": (dir_row or {}).get("team"),
                            "manager_email": (dir_row or {}).get("manager_email"),
                            "persona": "mgr"}}

    # 2b) Legacy manager_accounts (backward-compat with pre-directory managers).
    try:
        with _get_db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT id,name,email,team,status,username,avatar_emoji,avatar_color "
                            "FROM manager_accounts WHERE LOWER(email)=%s", (email_l,))
                mgr = cur.fetchone()
    except Exception:
        mgr = None
    if mgr and mgr["status"] == "approved":
        return {"outcome": "approved", "persona": "mgr",
                "profile": {"id": mgr["id"], "name": mgr["name"], "email": mgr["email"],
                            "team": mgr["team"], "persona": "mgr",
                            "username": mgr.get("username"), "avatar_emoji": mgr.get("avatar_emoji"),
                            "avatar_color": mgr.get("avatar_color")}}

    # 3) Employee IN the directory — auto-provisioned, NO manager approval gate.
    # Being on the HR roster IS the authorization; routing is purely DOJ + capstone.
    # Manager approval is a separate, later action (see /api/onboarding/{id}) that
    # only TICKS capstone-completed to promote nj→exp early — it does not gate entry.
    if dir_row:
        name = f"{dir_row.get('first_name') or ''} {dir_row.get('last_name') or ''}".strip() or name_hint or email
        try:
            with _get_db() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    # Auto-create the app-state row (capstone flag, points, avatar, etc.)
                    # on first login; a no-op if it already exists.
                    cur.execute("""INSERT INTO onboarding_requests
                            (name, preferred_name, email, joining_date, role, team, manager, status)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,'approved')
                        ON CONFLICT (email) DO NOTHING""",
                        (name, dir_row.get("first_name") or name, email_l, dir_row.get("doj"),
                         dir_row.get("role"), dir_row.get("team"), dir_row.get("manager_name")))
                    cur.execute(
                        """SELECT id, name, preferred_name, email, capstone_started_at,
                                  username, avatar_emoji, avatar_color,
                                  COALESCE(capstone_completed, FALSE) AS capstone_completed,
                                  COALESCE(active_track, 'rtcdp') AS active_track,
                                  COALESCE(profile_confirmed, FALSE) AS profile_confirmed
                           FROM onboarding_requests WHERE LOWER(email)=%s""", (email_l,))
                    row = cur.fetchone()
        except Exception:
            row = None
        capstone_done = bool(row.get("capstone_completed", False)) if row else False
        persona, tenure = classify_persona(dir_row.get("doj"), capstone_done)
        track_code, track_label = _resolve_learning_track(
            dir_row.get("manager_name"), dir_row.get("team"), dir_row.get("role"))
        return {"outcome": "approved", "persona": persona, "profile": {
            "id": row["id"] if row else None,
            "name": name, "preferred_name": (row or {}).get("preferred_name") or name,
            "email": email, "role": dir_row.get("role"), "team": dir_row.get("team"), "manager": dir_row.get("manager_name"),
            "track": track_code, "track_label": track_label,
            "joining_date": str(dir_row["doj"]) if dir_row.get("doj") else None,
            "tenure": tenure, "persona": persona, "capstone_completed": capstone_done,
            "capstone_started_at": str(row["capstone_started_at"]) if row and row.get("capstone_started_at") else None,
            "active_track": (row or {}).get("active_track", "rtcdp"),
            "username": (row or {}).get("username"), "avatar_emoji": (row or {}).get("avatar_emoji"),
            "avatar_color": (row or {}).get("avatar_color"),
            "profile_confirmed": bool((row or {}).get("profile_confirmed", False)),
        }}

    # 4) NOT in the directory — IMS authentication IS the authorization gate.
    # Any valid Adobe IMS user is auto-provisioned as approved. If a row already
    # exists (e.g. a previous pending record), it is upgraded to approved.
    # Only explicitly declined users are still blocked.
    try:
        with _get_db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """SELECT id, name, preferred_name, email, team, manager, joining_date,
                              status, capstone_started_at, username, avatar_emoji, avatar_color,
                              COALESCE(capstone_completed, FALSE) AS capstone_completed,
                              COALESCE(active_track, 'rtcdp') AS active_track
                       FROM onboarding_requests WHERE LOWER(email)=%s
                       ORDER BY created_at DESC LIMIT 1""", (email_l,))
                row = cur.fetchone()
    except Exception:
        row = None

    # Hard block: admin explicitly declined this user.
    if row and row["status"] == "declined":
        return {"outcome": "declined"}

    # Auto-provision: upsert an approved row so the user gets in immediately.
    # joining_date is left NULL. NOTE: classify_persona(None, capstone_completed)
    # returns "nj" (New Joiner) unless capstone_completed is already True — it does
    # NOT default to "exp" for an unknown DOJ. (An earlier version of this comment
    # claimed otherwise; that was never true of the current classify_persona logic.)
    try:
        with _get_db() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    INSERT INTO onboarding_requests
                        (name, preferred_name, email, joining_date, role, team, manager, status)
                    VALUES (%s, %s, %s, NULL, 'learner', NULL, NULL, 'approved')
                    ON CONFLICT (email) DO UPDATE SET
                        status = CASE WHEN onboarding_requests.status = 'declined'
                                      THEN 'declined'
                                      ELSE 'approved' END,
                        name = EXCLUDED.name
                    RETURNING id, name, preferred_name, email, team, manager, joining_date,
                              status, capstone_started_at, username, avatar_emoji, avatar_color,
                              COALESCE(capstone_completed, FALSE) AS capstone_completed,
                              COALESCE(active_track, 'rtcdp') AS active_track,
                              COALESCE(profile_confirmed, FALSE) AS profile_confirmed
                """, (name_hint or email, name_hint or email, email_l))
                row = cur.fetchone()
    except Exception:
        row = None

    if not row or row["status"] == "declined":
        return {"outcome": "declined"}

    capstone_done = bool(row.get("capstone_completed", False))
    # NULL joining_date → classify_persona returns exp (treated as >6 months)
    persona, tenure = classify_persona(row.get("joining_date"), capstone_done)

    return {"outcome": "approved", "persona": persona, "profile": {
        "id": row["id"], "name": row["name"], "preferred_name": row.get("preferred_name") or row["name"],
        "email": row["email"], "team": row.get("team"), "manager": row.get("manager"),
        "joining_date": str(row["joining_date"]) if row.get("joining_date") else None,
        "tenure": tenure, "persona": persona, "capstone_completed": capstone_done,
        "capstone_started_at": str(row["capstone_started_at"]) if row.get("capstone_started_at") else None,
        "active_track": row.get("active_track", "rtcdp"),
        "username": row.get("username"), "avatar_emoji": row.get("avatar_emoji"),
        "avatar_color": row.get("avatar_color"),
        "profile_confirmed": bool(row.get("profile_confirmed", False)),
    }}


# ── Cookie helpers ────────────────────────────────────────────────────────────
def _set_cookie(resp, name: str, value: str, ttl: int):
    resp.set_cookie(name, value, max_age=ttl, httponly=True, secure=COOKIE_SECURE,
                    samesite=COOKIE_SAMESITE, path="/")


def _clear_cookie(resp, name: str):
    resp.delete_cookie(name, path="/")


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/api/auth/ims/config")
def ims_config():
    """Lets the frontend show the 'Sign in with Adobe' button and build the
    IMPLICIT-grant authorize URL. Only public values are exposed (never the secret)."""
    return {
        "configured": IMS_CONFIGURED,
        "environment": IMS_ENV,
        "authorize_url": AUTHORIZE_URL,
        "client_id": IMS_CLIENT_ID,
        "scope": IMS_SCOPE,
        "redirect_uri": IMS_REDIRECT_URI,
        "locale": IMS_LOCALE,
    }


def _validate_ims_token(token: str) -> bool:
    """Confirm the access token is genuine, unexpired, and issued to THIS client."""
    try:
        with httpx.Client(timeout=15) as client:
            r = client.post(VALIDATE_URL,
                            data={"type": "access_token", "client_id": IMS_CLIENT_ID, "token": token},
                            headers={"Content-Type": "application/x-www-form-urlencoded"})
        if r.status_code != 200:
            return False
        return bool(r.json().get("valid", False))
    except Exception:
        return False


def _fetch_ims_profile(token: str) -> dict:
    try:
        with httpx.Client(timeout=15) as client:
            r = client.get(PROFILE_URL, params={"client_id": IMS_CLIENT_ID},
                           headers={"Authorization": f"Bearer {token}"})
        return r.json() if r.status_code == 200 else {}
    except Exception:
        return {}


class ImsTokenSubmit(BaseModel):
    access_token: str


@router.post("/api/auth/ims/session")
def ims_session_from_token(body: ImsTokenSubmit):
    """IMPLICIT-grant path: the SPA obtained the access token from the URL fragment
    (#access_token=...) and posts it here. We validate it with IMS, read the profile,
    map the email to a Nexus account/role, and issue the signed session cookie —
    exactly the same session + role mapping the code flow would have produced."""
    if not IMS_CONFIGURED:
        raise HTTPException(status_code=503, detail="Adobe IMS is not configured on the server.")
    token = (body.access_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Missing access token.")
    if not _validate_ims_token(token):
        raise HTTPException(status_code=401, detail="Adobe token is invalid or expired.")

    profile = _fetch_ims_profile(token)
    email = (profile.get("email") or "").strip().lower()
    name_hint = (profile.get("displayName")
                 or " ".join(x for x in [profile.get("first_name"), profile.get("last_name")] if x)
                 or profile.get("name") or email)
    if not email:
        raise HTTPException(status_code=422,
            detail="Adobe profile did not include an email — add the email/profile scopes to the IMS client.")

    acct = _resolve_account(email, name_hint)
    outcome = acct["outcome"]

    if outcome in ("approved", "admin"):
        session = {
            "email": email, "persona": acct["persona"],
            "name": acct["profile"].get("name", name_hint),
            "profile": acct["profile"], "ims": True,
            "at": token, "at_exp": int(time.time()) + SESSION_TTL,
        }
        resp = JSONResponse({"ok": True, "persona": acct["persona"], "profile": acct["profile"]})
        _set_cookie(resp, SESSION_COOKIE, _sign(session, SESSION_TTL), SESSION_TTL)
        return resp
    if outcome == "pending":
        return JSONResponse({"ok": False, "status": "pending",
                             "name": acct.get("name", name_hint), "email": email})
    if outcome == "declined":
        return JSONResponse({"ok": False, "status": "declined", "email": email,
                             "reason": acct.get("reason")})
    # onboarding — carries directory prefill (if in the roster) for the form
    return JSONResponse({"ok": False, "status": "onboarding", "email": email,
                         "name": name_hint, "in_directory": acct.get("in_directory", False),
                         "prefill": acct.get("prefill")})


@router.get("/api/auth/ims/login")
def ims_login():
    """Start the IMS Authorization Code flow (redirects the browser to Adobe)."""
    if not IMS_CONFIGURED:
        raise HTTPException(status_code=503, detail="Adobe IMS is not configured on the server.")
    state = secrets.token_urlsafe(24)
    verifier, challenge = _make_pkce()
    params = {
        "client_id": IMS_CLIENT_ID,
        "scope": IMS_SCOPE,
        "response_type": "code",
        "redirect_uri": IMS_REDIRECT_URI,
        "locale": IMS_LOCALE,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    resp = RedirectResponse(f"{AUTHORIZE_URL}?{urlencode(params)}", status_code=302)
    # Bind state + PKCE verifier to this browser via a short-lived signed cookie.
    _set_cookie(resp, TX_COOKIE, _sign({"state": state, "verifier": verifier}, TX_TTL), TX_TTL)
    return resp


@router.get("/api/auth/ims/callback")
def ims_callback(request: Request, code: Optional[str] = None,
                 state: Optional[str] = None, error: Optional[str] = None):
    """Handle the redirect back from Adobe: exchange code, fetch profile, map to DB."""
    def _to_frontend(status: str, **extra):
        q = {"ims": status, **{k: v for k, v in extra.items() if v}}
        r = RedirectResponse(f"{FRONTEND_URL}/?{urlencode(q)}", status_code=302)
        _clear_cookie(r, TX_COOKIE)
        return r

    if error:
        return _to_frontend("error", reason=error)
    if not code or not state:
        return _to_frontend("error", reason="missing_code")

    tx = _verify(request.cookies.get(TX_COOKIE, ""))
    if not tx or not hmac.compare_digest(tx.get("state", ""), state):
        return _to_frontend("error", reason="bad_state")

    # 1) Exchange the authorization code for an access token (secret used here).
    try:
        with httpx.Client(timeout=15) as client:
            tok = client.post(TOKEN_URL, data={
                "grant_type": "authorization_code",
                "client_id": IMS_CLIENT_ID,
                "client_secret": IMS_CLIENT_SECRET,
                "code": code,
                "code_verifier": tx.get("verifier", ""),
                "redirect_uri": IMS_REDIRECT_URI,
            }, headers={"Content-Type": "application/x-www-form-urlencoded"})
        if tok.status_code != 200:
            return _to_frontend("error", reason="token_exchange_failed")
        token_data = tok.json()
        access_token = token_data.get("access_token")
        if not access_token:
            return _to_frontend("error", reason="no_access_token")
    except Exception:
        return _to_frontend("error", reason="token_exchange_error")

    # 2) Fetch the IMS profile (email + name identify the user).
    try:
        with httpx.Client(timeout=15) as client:
            prof = client.get(PROFILE_URL,
                              params={"client_id": IMS_CLIENT_ID},
                              headers={"Authorization": f"Bearer {access_token}"})
        profile = prof.json() if prof.status_code == 200 else {}
    except Exception:
        profile = {}

    email = (profile.get("email") or "").strip().lower()
    name_hint = (profile.get("displayName")
                 or " ".join(x for x in [profile.get("first_name"), profile.get("last_name")] if x)
                 or profile.get("name") or email)
    if not email:
        return _to_frontend("error", reason="no_email")

    # 3) Map the IMS identity to a Nexus account / role.
    acct = _resolve_account(email, name_hint)
    outcome = acct["outcome"]

    if outcome in ("approved", "admin"):
        session = {
            "email": email,
            "persona": acct["persona"],
            "name": acct["profile"].get("name", name_hint),
            "profile": acct["profile"],
            "ims": True,
            "at": access_token,                       # access token kept server-side only
            "at_exp": int(time.time()) + int(token_data.get("expires_in", SESSION_TTL)),
        }
        resp = _to_frontend("ok")
        _set_cookie(resp, SESSION_COOKIE, _sign(session, SESSION_TTL), SESSION_TTL)
        return resp
    if outcome == "pending":
        return _to_frontend("pending", name=acct.get("name", name_hint), email=email)
    if outcome == "declined":
        return _to_frontend("declined", email=email)
    # No Nexus account yet -> send them to the onboarding form, pre-filled.
    return _to_frontend("onboarding", email=email, name=name_hint)


@router.get("/api/auth/session")
def get_session(request: Request):
    """Return the current IMS session (used by the SPA to restore login on load)."""
    payload = _verify(request.cookies.get(SESSION_COOKIE, ""))
    if not payload:
        return JSONResponse({"ok": False}, status_code=401)
    return {"ok": True, "persona": payload.get("persona"),
            "profile": payload.get("profile"), "email": payload.get("email")}


@router.post("/api/auth/logout")
def logout(request: Request):
    """Clear the Nexus session cookie and return the IMS logout URL for the SPA to
    redirect to. Ending Adobe's SSO session is what lets a user sign in as a
    *different* account next time (otherwise Adobe silently re-uses the current
    SSO session and never shows the account screen)."""
    ims_logout_url = None
    if IMS_CONFIGURED:
        # redirect_uri must match a registered Redirect Url Pattern → reuse the
        # login redirect (https://localhost:5173/), not the bare FRONTEND_URL.
        # NOTE: do NOT pass access_token as a query param — IMS rejects it
        # ("sensitive_query_param_not_allowed"). The browser's own IMS SSO
        # cookie (already present from login) is what /ims/logout/v1 clears.
        params = {"client_id": IMS_CLIENT_ID, "redirect_uri": IMS_REDIRECT_URI}
        ims_logout_url = f"{LOGOUT_URL}?{urlencode(params)}"
    resp = JSONResponse({"ok": True, "ims_logout_url": ims_logout_url})
    _clear_cookie(resp, SESSION_COOKIE)
    return resp


# ── Dependency: verify a request carries a valid IMS session ──────────────────
def get_current_user(request: Request) -> dict:
    """FastAPI dependency. Raises 401 unless a valid nexus_session cookie is present."""
    payload = _verify(request.cookies.get(SESSION_COOKIE, ""))
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return payload


def require_persona(*allowed: str):
    """Dependency factory that also enforces the caller's persona/role."""
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if allowed and user.get("persona") not in allowed:
            raise HTTPException(status_code=403, detail="Insufficient privileges.")
        return user
    return _dep