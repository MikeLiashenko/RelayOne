/**
 * RelayOne — Client session & route protection
 * ---------------------------------------------------------------------------
 * Single source of truth for the authenticated user on the frontend:
 *   • persists the session token in localStorage (survives refresh/restart)
 *   • an authenticated `apiFetch` wrapper
 *   • `fetchMe()` to restore/validate the session against the backend
 *   • route guards: requireAuth (protected pages) / requireGuest (welcome/auth)
 *   • logout
 *
 * Dev-only: API errors are logged to the console (codes/messages only — never
 * tokens or secrets), and `window.__relayone` exposes inspection helpers.
 */

export const API_BASE =
  (typeof window !== "undefined" && window.RELAYONE_API_BASE) ||
  "http://localhost:4000";
export const API = `${API_BASE}/api`;

export const IS_DEV = ["localhost", "127.0.0.1", "[::1]", ""].includes(
  typeof location !== "undefined" ? location.hostname : ""
);

const SESSION_KEY = "relayone.session";

/* -- Session storage ------------------------------------------------------- */

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(session) {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        token: session.token,
        expiresAt: session.expiresAt,
        user: session.user,
      })
    );
  } catch {
    /* storage unavailable */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** A locally-present, non-expired session (not yet server-validated). */
export function hasLocalSession() {
  const s = getSession();
  if (!s || !s.token) return false;
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) return false;
  return true;
}

export function currentUser() {
  return getSession()?.user ?? null;
}

/* -- API ------------------------------------------------------------------- */

export async function apiFetch(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (auth) {
    const token = getSession()?.token;
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (IS_DEV) console.warn(`[RelayOne] network error → ${method} ${path}`, err);
    return { ok: false, status: 0, error: { code: "network", message: "Can’t reach RelayOne." } };
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204 / empty */
  }

  const out = { ok: res.ok, status: res.status, data: json?.data, error: json?.error };
  if (!res.ok && IS_DEV) {
    console.warn(`[RelayOne] ${method} ${path} → ${res.status}`, out.error);
  }
  return out;
}

/* -- Auth state ------------------------------------------------------------ */

/** Validate the stored session against the backend; returns the user or null. */
export async function fetchMe() {
  if (!hasLocalSession()) return null;
  const r = await apiFetch("/users/me");
  if (r.status === 401) {
    clearSession();
    return null;
  }
  if (!r.ok) return null; // transient (e.g. server down) — keep session
  const s = getSession();
  if (s) {
    s.user = r.data;
    setSession(s);
  }
  return r.data;
}

export async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    /* best-effort; clear locally regardless */
  }
  clearSession();
}

/* -- Route guards ---------------------------------------------------------- */

/** Protected pages: redirect to `redirect` unless a valid session exists. */
export async function requireAuth(redirect = "index.html") {
  if (!hasLocalSession()) {
    location.replace(redirect);
    return null;
  }
  const me = await fetchMe();
  if (!me) {
    location.replace(redirect);
    return null;
  }
  return me;
}

/** Welcome/auth pages: redirect authenticated users to the main interface. */
export async function requireGuest(redirect = "app.html") {
  if (!hasLocalSession()) return;
  const me = await fetchMe();
  if (me) location.replace(redirect);
  // else the stale session was cleared by fetchMe — stay on the page.
}

if (IS_DEV && typeof window !== "undefined") {
  // Dev inspection surface (no secrets are printed).
  window.__relayone = { getSession, currentUser, fetchMe, logout, clearSession, API };
}
