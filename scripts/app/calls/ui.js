/**
 * RelayOne Calls — UI layer.
 *
 * Owns a self-contained overlay (incoming card + active call screen) appended
 * to <body>, and reflects engine snapshots + media streams into it. Reuses the
 * RelayOne design tokens (see styles/calls.css); adds no dependency on the
 * existing chat markup so the messaging UI is untouched.
 */
import { avatarHue, initials } from "../dom.js";
import { CallState } from "./engine.js";

const ICON = {
  mic: `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24" fill="none"><path d="M9 9V6a3 3 0 0 1 5.6-1.5M15 12.5a3 3 0 0 1-3 1.5M6 11a6 6 0 0 0 9.5 4.9M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  cam: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M15 10l6-3v10l-6-3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  camOff: `<svg viewBox="0 0 24 24" fill="none"><path d="M15 10l6-3v10l-4-2M13 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  flipCam: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L18 6h0a2 2 0 0 1 2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 16a8 8 0 0 1-13 3M4 12a8 8 0 0 1 13-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 5l1 4-4 0M7 19l-1-4 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  swapMic: `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M4 15a8 8 0 0 0 14 4M20 13a8 8 0 0 0-14-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 5l1 4-4 0M7 19l-1-4 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  hangup: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 13.5c4-4 11-4 15 0 .8.8.8 1.4.2 2.3l-1.4 1.4c-.6.6-1.2.5-1.9.1l-1.8-1.2c-.5-.3-.6-.7-.5-1.3l.2-1.1c-2-.9-4.5-.9-6.5 0l.2 1.1c.1.6 0 1-.5 1.3l-1.8 1.2c-.7.4-1.3.5-1.9-.1L2.3 15.8c-.6-.9-.6-1.5.2-2.3z" fill="currentColor" transform="rotate(135 12 14)"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 5.5c3 6 9 12 15 15l-2.2 2.2c-.6.6-1.4.7-2.1.3C9.8 20.4 5.6 16.2 2.5 10.8c-.4-.7-.3-1.5.3-2.1L4.5 5.5z" fill="currentColor"/></svg>`,
};

export function createCallUI(engine) {
  const root = document.createElement("div");
  root.className = "call";
  root.setAttribute("data-call-root", "");
  root.hidden = true;
  root.innerHTML = `
    <section class="call__screen" data-call-screen hidden>
      <div class="call__stage">
        <video class="call__remote" data-call-remote autoplay playsinline></video>
        <div class="call__face" data-call-face>
          <div class="call__avatar call__avatar--xl" data-call-avatar></div>
        </div>
        <video class="call__local" data-call-local autoplay playsinline muted></video>
      </div>
      <header class="call__topbar">
        <span class="call__name" data-call-name></span>
        <span class="call__status" data-call-status></span>
      </header>
      <div class="call__controls" data-call-controls></div>
    </section>

    <section class="call-incoming" data-call-incoming hidden>
      <div class="call__avatar call-incoming__avatar" data-call-in-avatar></div>
      <div class="call-incoming__meta">
        <span class="call-incoming__name" data-call-in-name></span>
        <span class="call-incoming__sub" data-call-in-sub></span>
      </div>
      <div class="call-incoming__actions" data-call-in-actions></div>
    </section>
  `;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const screen = $("[data-call-screen]");
  const incoming = $("[data-call-incoming]");
  const remoteVideo = $("[data-call-remote]");
  const localVideo = $("[data-call-local]");
  const faceAvatar = $("[data-call-avatar]");
  const nameEl = $("[data-call-name]");
  const statusEl = $("[data-call-status]");
  const controls = $("[data-call-controls]");
  const inAvatar = $("[data-call-in-avatar]");
  const inName = $("[data-call-in-name]");
  const inSub = $("[data-call-in-sub]");
  const inActions = $("[data-call-in-actions]");

  /* Build the control buttons once; keep refs to update icons/state. */
  const btn = {
    mute: makeBtn("mute", "Mute", () => engine.toggleMic()),
    camera: makeBtn("camera", "Camera", () => engine.toggleCamera()),
    switchCamera: makeBtn("switch-camera", "Switch camera", () => engine.switchCamera()),
    switchMic: makeBtn("switch-mic", "Switch microphone", () => engine.switchMic()),
    hangup: makeBtn("hangup", "End call", () => engine.hangup(), "call-btn--end"),
  };
  controls.append(btn.mute, btn.camera, btn.switchCamera, btn.switchMic, btn.hangup);

  const acceptBtn = makeBtn("accept", "Accept", () => engine.accept(), "call-btn--accept");
  const declineBtn = makeBtn("decline", "Decline", () => engine.decline(), "call-btn--end");
  inActions.append(declineBtn, acceptBtn);

  function makeBtn(kind, label, onClick, extra = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "call-btn" + (extra ? " " + extra : "");
    b.dataset.callAction = kind;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function setIcon(node, svg) {
    if (node.innerHTML !== svg) node.innerHTML = svg;
  }

  function fillAvatar(node, peer) {
    node.textContent = "";
    node.classList.remove("call__avatar--img");
    node.removeAttribute("style");
    const url = peer?.avatarUrl;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      node.classList.add("call__avatar--img");
      node.style.backgroundImage = `url("${encodeURI(url).replace(/["'()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16))}")`;
    } else {
      const name = peer?.name || "?";
      const h = avatarHue(name);
      node.style.background = `linear-gradient(135deg, hsl(${h} 80% 55%), hsl(${(h + 40) % 360} 80% 50%))`;
      node.textContent = initials(name);
    }
  }

  function fmtDuration(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const STATUS = {
    [CallState.CALLING]: () => "Calling…",
    [CallState.CONNECTING]: () => "Connecting…",
    [CallState.RECONNECTING]: () => "Reconnecting…",
  };
  const END_TEXT = {
    declined: "Call declined",
    "declined-by-me": "Call declined",
    canceled: "Call canceled",
    busy: "User is busy",
    unavailable: "User is unavailable",
    "no-answer": "No answer",
    missed: "Missed call",
    ended: "Call ended",
    "ended-by-me": "Call ended",
    "peer-disconnected": "Call ended — connection lost",
    "connection-lost": "Connection lost",
    "negotiation-failed": "Couldn’t connect",
  };
  const MEDIA_ERR = {
    "permission-denied": "Camera / microphone permission denied",
    "device-not-found": "No camera or microphone found",
    "device-in-use": "Camera or microphone is already in use",
    "media-error": "Couldn’t access camera or microphone",
    media: "Couldn’t access camera or microphone",
  };

  function statusText(snap) {
    if (snap.state === CallState.CONNECTED) return fmtDuration(snap.durationMs);
    if (snap.state === CallState.ENDED) {
      if (snap.error) return MEDIA_ERR[snap.error] || "Call ended";
      return END_TEXT[snap.endReason] || "Call ended";
    }
    return STATUS[snap.state]?.() ?? "";
  }

  function render(snap) {
    if (snap.state === CallState.IDLE) {
      root.hidden = true;
      screen.hidden = true;
      incoming.hidden = true;
      return;
    }
    root.hidden = false;

    if (snap.state === CallState.INCOMING) {
      screen.hidden = true;
      incoming.hidden = false;
      fillAvatar(inAvatar, snap.peer);
      inName.textContent = snap.peer?.name || "Unknown";
      inSub.textContent = snap.media === "video" ? "Incoming video call" : "Incoming voice call";
      return;
    }

    // Active call screen.
    incoming.hidden = true;
    screen.hidden = false;

    const isVideo = snap.media === "video";
    const remoteHasVideo = remoteVideo.srcObject
      ? remoteVideo.srcObject.getVideoTracks().some((t) => t.readyState === "live")
      : false;
    const showRemoteVideo = isVideo && snap.state !== CallState.ENDED && remoteHasVideo;

    screen.classList.toggle("call__screen--video", isVideo);
    remoteVideo.classList.toggle("is-visible", showRemoteVideo);
    $("[data-call-face]").hidden = showRemoteVideo;

    fillAvatar(faceAvatar, snap.peer);
    nameEl.textContent = snap.peer?.name || "Unknown";
    statusEl.textContent = statusText(snap);
    statusEl.classList.toggle("is-reconnecting", snap.state === CallState.RECONNECTING);

    // Local preview only when we're actually sending video.
    const showLocal = isVideo && snap.camOn && snap.hasLocalVideo && snap.state !== CallState.ENDED;
    localVideo.classList.toggle("is-visible", showLocal);

    // Control icons + states.
    setIcon(btn.mute, snap.micOn ? ICON.mic : ICON.micOff);
    btn.mute.classList.toggle("is-off", !snap.micOn);

    btn.camera.hidden = !isVideo;
    setIcon(btn.camera, snap.camOn ? ICON.cam : ICON.camOff);
    btn.camera.classList.toggle("is-off", !snap.camOn);

    btn.switchCamera.hidden = !isVideo;
    setIcon(btn.switchCamera, ICON.flipCam);
    setIcon(btn.switchMic, ICON.swapMic);
    setIcon(btn.hangup, ICON.hangup);

    // Disable controls once the call is over.
    const done = snap.state === CallState.ENDED;
    for (const b of [btn.mute, btn.camera, btn.switchCamera, btn.switchMic]) b.disabled = done;
  }

  // Static icons for the incoming buttons.
  setIcon(acceptBtn, ICON.phone);
  setIcon(declineBtn, ICON.hangup);

  function setLocalStream(stream) {
    localVideo.srcObject = stream || null;
  }
  function setRemoteStream(stream) {
    remoteVideo.srcObject = stream || null;
  }

  function destroy() {
    setLocalStream(null);
    setRemoteStream(null);
    root.remove();
  }

  return { render, setLocalStream, setRemoteStream, destroy };
}
