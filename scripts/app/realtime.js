/**
 * Reconnecting WebSocket client for the RelayOne realtime layer.
 * Emits parsed server events via `onEvent` and connection status via `onStatus`
 * ("connecting" | "online" | "reconnecting" | "offline").
 */
import { API_BASE, getSession } from "../auth/session.js";

export function createRealtime({ onEvent, onStatus }) {
  let ws = null;
  let reconnectTimer = null;
  let heartbeat = null;
  let shouldRun = true;
  let backoff = 1000;

  function url() {
    const token = getSession()?.token ?? "";
    const base = API_BASE.replace(/^http/, "ws");
    return `${base}/ws?token=${encodeURIComponent(token)}`;
  }

  function connect() {
    if (!shouldRun) return;
    onStatus("connecting");
    ws = new WebSocket(url());

    ws.addEventListener("open", () => {
      backoff = 1000;
      onStatus("online");
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
    });
    ws.addEventListener("message", (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.addEventListener("close", () => {
      clearInterval(heartbeat);
      if (shouldRun) scheduleReconnect();
      else onStatus("offline");
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    onStatus("reconnecting");
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(Math.round(backoff * 1.7), 15_000);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  connect();

  return {
    send,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    stop() {
      shouldRun = false;
      clearTimeout(reconnectTimer);
      clearInterval(heartbeat);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
