/**
 * RelayOne — Auth service (API-backed)
 * ---------------------------------------------------------------------------
 * Registration + login flows against the RelayOne backend. Keeps the method
 * surface the registration UI already uses so `register.js` is unchanged in
 * shape. Session persistence + the API wrapper live in `session.js`.
 *
 * In development the backend returns a `devCode` (no SMS/email provider yet),
 * surfaced via the `relayone:devcode` event (and the on-screen dev chip).
 */

import { apiFetch, setSession, getSession, IS_DEV } from "./session.js";

/** In-flight verification/registration state. */
const flow = { verificationId: null, registrationTicket: null };

const NETWORK_ERROR =
  "Can’t reach RelayOne right now. Make sure the server is running.";

function surfaceDevCode(data) {
  if (data && data.devCode) {
    if (IS_DEV) {
      // eslint-disable-next-line no-console
      console.info(
        `%c[RelayOne dev]%c verification code: %c${data.devCode}`,
        "color:#168BFF;font-weight:600",
        "color:inherit",
        "color:#35D6A4;font-weight:700;font-size:14px"
      );
    }
    document.dispatchEvent(
      new CustomEvent("relayone:devcode", { detail: { code: data.devCode } })
    );
  }
}

export const authService = {
  async startRegistration({ channel, identifier }) {
    const r = await apiFetch("/auth/register/start", {
      method: "POST",
      body: { channel, identifier },
      auth: false,
    });
    if (r.status === 0) return { ok: false, message: NETWORK_ERROR };
    if (!r.ok) {
      return {
        ok: false,
        code: r.error?.code,
        message: r.error?.message ?? "Couldn’t start sign-up.",
      };
    }
    flow.verificationId = r.data.verificationId;
    surfaceDevCode(r.data);
    return { ok: true };
  },

  async startLogin({ channel, identifier }) {
    const r = await apiFetch("/auth/login/start", {
      method: "POST",
      body: { channel, identifier },
      auth: false,
    });
    if (r.status === 0) return { ok: false, message: NETWORK_ERROR };
    if (!r.ok) {
      return {
        ok: false,
        code: r.error?.code,
        message: r.error?.message ?? "Couldn’t start login.",
      };
    }
    flow.verificationId = r.data.verificationId;
    surfaceDevCode(r.data);
    return { ok: true };
  },

  async resendCode() {
    if (!flow.verificationId) return { ok: false };
    const r = await apiFetch("/auth/resend", {
      method: "POST",
      body: { verificationId: flow.verificationId },
      auth: false,
    });
    if (!r.ok) return { ok: false };
    flow.verificationId = r.data.verificationId;
    surfaceDevCode(r.data);
    return { ok: true };
  },

  async verifyCode(code) {
    if (!flow.verificationId) return { ok: false, error: "no_session" };
    const r = await apiFetch("/auth/verify", {
      method: "POST",
      body: { verificationId: flow.verificationId, code },
      auth: false,
    });
    if (r.status === 0) return { ok: false, error: "network", message: NETWORK_ERROR };
    if (!r.ok) {
      return {
        ok: false,
        error: r.error?.code ?? "invalid_code",
        message: r.error?.message,
      };
    }
    if (r.data.status === "registration") {
      flow.registrationTicket = r.data.registrationTicket;
    } else if (r.data.status === "authenticated") {
      // Login path: an authenticated session comes back immediately.
      setSession(r.data.session);
    }
    return { ok: true };
  },

  async checkUsername(username) {
    const r = await apiFetch(
      `/users/username-available?username=${encodeURIComponent(username)}`,
      { auth: false }
    );
    if (!r.ok) return { status: "taken" };
    return { status: r.data.available ? "available" : "taken" };
  },

  async completeProfile(profile) {
    if (!flow.registrationTicket) {
      return { ok: false, message: "Please verify your contact first." };
    }
    const r = await apiFetch("/auth/register/complete", {
      method: "POST",
      body: {
        registrationTicket: flow.registrationTicket,
        displayName: profile.displayName,
        username: profile.username,
      },
      auth: false,
    });
    if (r.status === 0) return { ok: false, message: NETWORK_ERROR };
    if (!r.ok) {
      return { ok: false, message: r.error?.message ?? "Couldn’t create your profile." };
    }
    setSession(r.data); // AuthSession: { token, expiresAt, user }

    // If a photo was chosen during sign-up, upload it now — the session token
    // (required by the upload endpoint) only exists once the account is created.
    // Best-effort: a failed avatar upload must never fail account creation; the
    // user can always set it later in Settings.
    if (profile.avatarFile) {
      try {
        const url = await uploadAvatarFile(profile.avatarFile);
        const patched = await apiFetch("/users/me", {
          method: "PATCH",
          body: { avatarUrl: url },
        });
        if (patched.ok) {
          const s = getSession();
          if (s) {
            s.user = patched.data;
            setSession(s);
          }
        }
      } catch (err) {
        if (IS_DEV) console.warn("[RelayOne] avatar upload during sign-up failed", err);
      }
    }

    return { ok: true, profile };
  },
};

/**
 * Two-step upload used during sign-up: register the attachment, PUT the bytes
 * to the returned target, then resolve to its public URL (for `avatarUrl`).
 * Mirrors the app's profile-editor upload so behaviour is identical.
 */
async function uploadAvatarFile(file) {
  const created = await apiFetch("/attachments", {
    method: "POST",
    body: {
      kind: "image",
      mimeType: file.type,
      sizeBytes: file.size,
      fileName: file.name,
    },
  });
  if (!created.ok) {
    throw new Error(created.error?.message ?? "Couldn’t start the avatar upload.");
  }

  const { attachment, upload } = created.data;
  const token = getSession()?.token;
  const res = await fetch(upload.uploadUrl, {
    method: upload.method || "PUT",
    headers: {
      ...(upload.headers || {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  if (!res.ok) throw new Error("Avatar upload failed.");
  return attachment.url;
}

export default authService;
