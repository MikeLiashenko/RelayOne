/**
 * RelayOne Calls — group call UI (mesh grid).
 *
 * A self-contained overlay appended to <body>: an incoming "join" card and an
 * active screen with a responsive grid of participant tiles (remote video, or a
 * gradient avatar when a tile has no live video). Reflects group-engine
 * snapshots; reconciles tiles by userId so streams bind once and don't flicker.
 */
import { avatarHue, initials } from "../dom.js";
import { GroupCallState } from "./groupEngine.js";

const ICON = {
  mic: `<svg viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24" fill="none"><path d="M9 9V6a3 3 0 0 1 5.6-1.5M15 12.5a3 3 0 0 1-3 1.5M6 11a6 6 0 0 0 9.5 4.9M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  cam: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M15 10l6-3v10l-6-3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  camOff: `<svg viewBox="0 0 24 24" fill="none"><path d="M15 10l6-3v10l-4-2M13 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  flipCam: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L18 6h0a2 2 0 0 1 2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 16a8 8 0 0 1-13 3M4 12a8 8 0 0 1 13-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17 5l1 4-4 0M7 19l-1-4 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  hangup: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 13.5c4-4 11-4 15 0 .8.8.8 1.4.2 2.3l-1.4 1.4c-.6.6-1.2.5-1.9.1l-1.8-1.2c-.5-.3-.6-.7-.5-1.3l.2-1.1c-2-.9-4.5-.9-6.5 0l.2 1.1c.1.6 0 1-.5 1.3l-1.8 1.2c-.7.4-1.3.5-1.9-.1L2.3 15.8c-.6-.9-.6-1.5.2-2.3z" fill="currentColor" transform="rotate(135 12 14)"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 5.5c3 6 9 12 15 15l-2.2 2.2c-.6.6-1.4.7-2.1.3C9.8 20.4 5.6 16.2 2.5 10.8c-.4-.7-.3-1.5.3-2.1L4.5 5.5z" fill="currentColor"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 6M17.5 19a5.5 5.5 0 0 0-2-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

export function createGroupCallUI(engine) {
  const root = document.createElement("div");
  root.className = "gcall";
  root.setAttribute("data-gcall-root", "");
  root.hidden = true;
  root.innerHTML = `
    <section class="gcall__screen" data-gcall-screen hidden>
      <header class="gcall__topbar">
        <span class="gcall__title" data-gcall-title></span>
        <span class="gcall__status" data-gcall-status></span>
      </header>
      <div class="gcall__grid" data-gcall-grid></div>
      <div class="gcall__controls" data-gcall-controls></div>
    </section>

    <section class="gcall-incoming" data-gcall-incoming hidden>
      <div class="gcall-incoming__glyph" data-gcall-in-glyph></div>
      <div class="gcall-incoming__meta">
        <span class="gcall-incoming__title" data-gcall-in-title></span>
        <span class="gcall-incoming__sub" data-gcall-in-sub></span>
      </div>
      <div class="gcall-incoming__actions" data-gcall-in-actions></div>
    </section>
  `;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const screen = $("[data-gcall-screen]");
  const incoming = $("[data-gcall-incoming]");
  const grid = $("[data-gcall-grid]");
  const titleEl = $("[data-gcall-title]");
  const statusEl = $("[data-gcall-status]");
  const controls = $("[data-gcall-controls]");
  const inGlyph = $("[data-gcall-in-glyph]");
  const inTitle = $("[data-gcall-in-title]");
  const inSub = $("[data-gcall-in-sub]");
  const inActions = $("[data-gcall-in-actions]");

  inGlyph.innerHTML = ICON.users;

  const btn = {
    mute: makeBtn("Mute", () => engine.toggleMic()),
    camera: makeBtn("Camera", () => engine.toggleCamera()),
    switchCamera: makeBtn("Switch camera", () => engine.switchCamera()),
    hangup: makeBtn("Leave", () => engine.hangup(), "call-btn--end"),
  };
  controls.append(btn.mute, btn.camera, btn.switchCamera, btn.hangup);

  const joinBtn = makeBtn("Join", () => engine.accept(), "call-btn--accept");
  const dismissBtn = makeBtn("Dismiss", () => engine.decline(), "call-btn--end");
  inActions.append(dismissBtn, joinBtn);
  joinBtn.innerHTML = ICON.phone;
  dismissBtn.innerHTML = ICON.hangup;

  function makeBtn(label, onClick, extra = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "call-btn" + (extra ? " " + extra : "");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  }
  function setIcon(node, svg) {
    if (node.innerHTML !== svg) node.innerHTML = svg;
  }

  function fillAvatar(node, who) {
    node.textContent = "";
    node.classList.remove("gcall-tile__avatar--img");
    node.removeAttribute("style");
    const url = who?.avatarUrl;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      node.classList.add("gcall-tile__avatar--img");
      node.style.backgroundImage = `url("${encodeURI(url).replace(/["'()\\]/g, (c) => "%" + c.charCodeAt(0).toString(16))}")`;
    } else {
      const name = who?.name || "?";
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

  /* -- Tile reconciliation ------------------------------------------------ */

  const tiles = new Map(); // key -> { el, video, face, avatar, nameEl }
  let localStream = null;

  function ensureTile(key) {
    let t = tiles.get(key);
    if (t) return t;
    const el = document.createElement("div");
    el.className = "gcall-tile";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.className = "gcall-tile__video";
    const face = document.createElement("div");
    face.className = "gcall-tile__face";
    const avatar = document.createElement("div");
    avatar.className = "gcall-tile__avatar";
    face.appendChild(avatar);
    const nameEl = document.createElement("span");
    nameEl.className = "gcall-tile__name";
    el.append(video, face, nameEl);
    grid.appendChild(el);
    t = { el, video, face, avatar, nameEl };
    tiles.set(key, t);
    return t;
  }

  function bindStream(video, stream) {
    if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
  }

  function hasLiveVideo(stream) {
    return stream ? stream.getVideoTracks().some((t) => t.readyState === "live" && t.enabled) : false;
  }

  function paintTile(key, who, stream, { muted = false, showVideo = true } = {}) {
    const t = ensureTile(key);
    t.nameEl.textContent = who?.name || "Unknown";
    t.video.muted = muted;
    bindStream(t.video, stream);
    const live = showVideo && hasLiveVideo(stream);
    t.video.classList.toggle("is-visible", live);
    t.face.hidden = live;
    if (!live) fillAvatar(t.avatar, who);
    return key;
  }

  /* -- Render ------------------------------------------------------------- */

  const END_LINGER_TEXT = "Call ended";

  function render(snap) {
    if (snap.state === GroupCallState.IDLE) {
      root.hidden = true;
      screen.hidden = true;
      incoming.hidden = true;
      // Drop tiles so stale videos don't linger next call.
      for (const [, t] of tiles) t.el.remove();
      tiles.clear();
      return;
    }
    root.hidden = false;

    if (snap.state === GroupCallState.RINGING) {
      screen.hidden = true;
      incoming.hidden = false;
      inTitle.textContent = snap.chatTitle || "Group call";
      const who = snap.pendingInvite?.inviterName || "Someone";
      inSub.textContent = `${who} started a ${snap.media === "video" ? "video" : "voice"} call`;
      return;
    }

    incoming.hidden = true;
    screen.hidden = false;

    titleEl.textContent = snap.chatTitle || "Group call";
    const dur = snap.durationMs ? fmtDuration(snap.durationMs) : "";
    const who = `${snap.count} in call`;
    statusEl.textContent =
      snap.state === GroupCallState.ENDED ? END_LINGER_TEXT : dur ? `${who} · ${dur}` : who;

    const isVideo = snap.media === "video";

    // Reconcile tiles: self first, then each participant.
    const seen = new Set();
    const selfKey = "self";
    seen.add(selfKey);
    paintTile(selfKey, { name: `${snap.self.name} (you)`, avatarUrl: snap.self.avatarUrl }, localStream, {
      muted: true,
      showVideo: isVideo && snap.camOn,
    });

    for (const p of snap.participants) {
      seen.add(p.userId);
      paintTile(p.userId, { name: p.name, avatarUrl: p.avatarUrl }, p.stream, {
        muted: false,
        showVideo: isVideo,
      });
    }

    // Remove tiles for participants who left.
    for (const [key, t] of tiles) {
      if (!seen.has(key)) {
        bindStream(t.video, null);
        t.el.remove();
        tiles.delete(key);
      }
    }

    // Grid density hint (for CSS column sizing).
    grid.dataset.count = String(tiles.size);

    // Controls.
    setIcon(btn.mute, snap.micOn ? ICON.mic : ICON.micOff);
    btn.mute.classList.toggle("is-off", !snap.micOn);
    btn.camera.hidden = !isVideo;
    setIcon(btn.camera, snap.camOn ? ICON.cam : ICON.camOff);
    btn.camera.classList.toggle("is-off", !snap.camOn);
    btn.switchCamera.hidden = !isVideo;
    setIcon(btn.switchCamera, ICON.flipCam);
    setIcon(btn.hangup, ICON.hangup);

    const done = snap.state === GroupCallState.ENDED;
    for (const b of [btn.mute, btn.camera, btn.switchCamera]) b.disabled = done;
  }

  function setLocalStream(stream) {
    localStream = stream || null;
    const t = tiles.get("self");
    if (t) bindStream(t.video, localStream);
  }

  function destroy() {
    for (const [, t] of tiles) t.el.remove();
    tiles.clear();
    root.remove();
  }

  return { render, setLocalStream, destroy };
}
