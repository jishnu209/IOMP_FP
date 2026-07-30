// ── Adobe IMS client (SPA side) — IMPLICIT grant ─────────────────────────────
// The client is registered for Implicit grant, so the access token is returned
// straight to the browser in the URL fragment (#access_token=...). We then hand
// that token to the backend, which validates it with IMS, reads the profile,
// maps the email to a Nexus account/role, and sets a signed httpOnly session.
// (The backend keeps doing the role mapping + session; only token acquisition
// moved to the browser.)

import { BACKEND } from "./api.js";

const STATE_KEY = "nexus_ims_state"; // CSRF state, round-tripped via sessionStorage

let _cfg = null;
async function getConfig() {
  if (_cfg) return _cfg;
  try {
    const r = await fetch(`${BACKEND}/api/auth/ims/config`, { credentials: "include" });
    if (!r.ok) return null;
    _cfg = await r.json();
    return _cfg;
  } catch {
    return null;
  }
}

// Start Adobe IMS sign-in (Implicit grant): full-page redirect to Adobe's
// /ims/authorize/v1 with response_type=token. Adobe returns the token in the
// fragment of our redirect_uri (the frontend origin).
// opts.prompt: pass "select_account" (or "login") to FORCE Adobe to show the
// account/login screen even when an SSO session already exists — used by the
// "Use a different Adobe account" link so you can switch users. Omit for the
// normal button, which uses SSO (returning users sign in without re-typing).
export async function loginWithIMS(opts = {}) {
  const cfg = await getConfig();
if (!cfg || !cfg.configured || !cfg.authorize_url) {
    return;
}
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    scope: cfg.scope,
    response_type: "token",
    redirect_uri: cfg.redirect_uri,
    locale: cfg.locale || "en_US",
    state,
  });
  if (opts.prompt) params.set("prompt", opts.prompt);
  window.location.href = `${cfg.authorize_url}?${params.toString()}`;
}

// Parse the implicit response from the URL fragment on return from Adobe.
// Returns {token,state,error,expiresIn} or null when there's nothing to handle.
// Also strips the fragment from the address bar and verifies the CSRF state.
export function parseImsFragment() {
  const hash = window.location.hash || "";
  const h = hash.replace(/^#/, "");
  if (!h || !/(^|&)(access_token|error)=/.test(h)) return null;

  const p = new URLSearchParams(h);
  const result = {
    token: p.get("access_token") || "",
    state: p.get("state") || "",
    error: p.get("error") || p.get("error_description") || "",
    expiresIn: p.get("expires_in") || "",
  };
  // Clean the fragment out of the URL so a refresh doesn't re-process it.
  window.history.replaceState({}, "", window.location.pathname + window.location.search);

  // CSRF: the state we sent must match the one Adobe echoed back.
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (result.token && expected && result.state && result.state !== expected) {
    return { error: "state_mismatch" };
  }
  return result;
}

// Hand the implicit token to the backend to validate + map + set the session.
// Returns {ok:true,persona,profile} or {ok:false,status:"pending|declined|onboarding",...}
// or {ok:false,detail}.
export async function submitImsToken(token) {
  try {
    const r = await fetch(`${BACKEND}/api/auth/ims/session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, detail: d.detail || `Sign-in failed (${r.status}).` };
    return d;
  } catch {
    return { ok: false, detail: "Could not reach the server." };
  }
}

// Restore an existing session on page load (refresh persistence).
export async function fetchSession() {
  try {
    const r = await fetch(`${BACKEND}/api/auth/session`, { credentials: "include" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Clear the backend session cookie.
export async function logoutIMS() {
  try {
    const r = await fetch(`${BACKEND}/api/auth/logout`, { method: "POST", credentials: "include" });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

// Full sign-out: clear the Nexus session cookie AND end Adobe's own SSO session,
// so the next "Sign in with Adobe" doesn't silently re-use the previous account.
// If the backend returns an IMS logout URL we navigate there (Adobe clears its
// SSO cookie, then redirects back to the app). Returns true if we're navigating
// away (caller should NOT bother resetting local state); false otherwise.
export async function signOutAdobe() {
  const res = await logoutIMS();            // clears our cookie, returns ims_logout_url
  if (res && res.ims_logout_url) {
    window.location.href = res.ims_logout_url;
    return true;
  }
  return false;
}

// Is IMS configured on the server? (drives the Adobe button's tooltip)
export async function imsConfigured() {
  const cfg = await getConfig();
  return !!(cfg && cfg.configured);
}
