/**
 * RelayOne — Web Push subscription helper.
 *
 * Turns browser push on/off for the signed-in user: asks permission, creates a
 * PushSubscription against the server's VAPID key, and registers it with the
 * backend. All backend calls go through the authenticated `apiFetch`.
 */
import { apiFetch } from "../auth/session.js";

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** VAPID keys are base64url; the Push API wants a Uint8Array. */
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export const push = {
  supported,

  /** Current state: { supported, permission, subscribed, available }. */
  async status() {
    if (!supported()) {
      return { supported: false, permission: "unsupported", subscribed: false, available: false };
    }
    let subscribed = false;
    try {
      const reg = await navigator.serviceWorker.ready;
      subscribed = Boolean(await reg.pushManager.getSubscription());
    } catch {
      /* ignore */
    }
    // Is push configured on the backend at all?
    let available = false;
    try {
      const r = await apiFetch("/push/vapid-public-key", { auth: false });
      available = Boolean(r.ok && r.data?.enabled);
    } catch {
      /* ignore */
    }
    return { supported: true, permission: Notification.permission, subscribed, available };
  },

  /** Ask permission, subscribe, and register with the backend. */
  async enable() {
    if (!supported()) throw new Error("Push isn’t supported in this browser.");

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notifications permission was denied.");

    const keyRes = await apiFetch("/push/vapid-public-key", { auth: false });
    if (!keyRes.ok || !keyRes.data?.key) throw new Error("Push isn’t configured on the server.");
    if (!keyRes.data.enabled) throw new Error("Push isn’t enabled on the server.");

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.data.key),
      });
    }

    const json = sub.toJSON();
    const r = await apiFetch("/push/subscribe", {
      method: "POST",
      body: { endpoint: json.endpoint, keys: json.keys },
    });
    if (!r.ok) throw new Error("Couldn’t register for notifications.");
    return true;
  },

  /** Unsubscribe this browser and tell the backend to forget it. */
  async disable() {
    if (!supported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await apiFetch("/push/unsubscribe", { method: "POST", body: { endpoint } });
      }
    } catch {
      /* best-effort */
    }
  },
};

export default push;
