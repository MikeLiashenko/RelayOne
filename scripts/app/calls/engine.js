/**
 * RelayOne Calls — engine (state machine + orchestration).
 *
 * Ties together signaling (via injected `send`), the local media controller,
 * and a peer connection into a single 1:1 call state machine. UI-agnostic: it
 * emits immutable snapshots through `subscribe`, and local/remote streams
 * through `onLocalStream` / `onRemoteStream`.
 *
 * States: idle → calling|incoming → connecting → connected → (reconnecting) → ended → idle
 */
import { createMediaController } from "./media.js";
import { createPeer } from "./peer.js";

export const CallState = {
  IDLE: "idle",
  CALLING: "calling",
  INCOMING: "incoming",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  ENDED: "ended",
};

const RING_TIMEOUT_MS = 35_000;
const RECONNECT_TIMEOUT_MS = 20_000;
const ENDED_LINGER_MS = 1_600;

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];

export function createEngine({ send, getMe, resolveUser, getIceServers }) {
  const subscribers = new Set();
  let localStreamCb = () => {};
  let remoteStreamCb = () => {};

  let iceServers = null;

  const media = createMediaController();
  let peer = null;

  // Call context ----------------------------------------------------------
  let state = CallState.IDLE;
  let callId = null;
  let role = null; // "caller" | "callee"
  let mediaKind = "audio"; // "audio" | "video"
  let peerUser = null; // { userId, name, avatarUrl }
  let pendingInvite = null; // { callId, fromUserId, media, chatId }
  let chatId = null;

  let micOn = true;
  let camOn = false;
  let connectedAt = 0;
  let iceRestartTried = false;
  let ended = false;

  // Timers ----------------------------------------------------------------
  let ringTimer = null;
  let durationTimer = null;
  let reconnectTimer = null;
  let endResetTimer = null;

  let error = null;
  let endReason = null;

  /* -- Snapshots ---------------------------------------------------------- */

  function snapshot() {
    return {
      state,
      media: mediaKind,
      role,
      peer: peerUser,
      micOn,
      camOn,
      hasLocalVideo: media.hasVideo(),
      durationMs: connectedAt ? Date.now() - connectedAt : 0,
      error,
      endReason,
    };
  }
  function emit() {
    const snap = snapshot();
    for (const cb of subscribers) cb(snap);
  }
  function setState(next) {
    state = next;
    emit();
  }

  /* -- Signaling helpers -------------------------------------------------- */

  function signal(type, extra = {}) {
    if (!peerUser) return;
    send({ type, callId, toUserId: peerUser.userId, ...extra });
  }

  async function ensureIce() {
    if (iceServers) return iceServers;
    try {
      const r = await getIceServers();
      iceServers = r?.ok && r.data?.iceServers?.length ? r.data.iceServers : DEFAULT_ICE;
    } catch {
      iceServers = DEFAULT_ICE;
    }
    return iceServers;
  }

  /* -- Peer wiring -------------------------------------------------------- */

  async function buildPeer() {
    const servers = await ensureIce();
    peer = createPeer({
      iceServers: servers,
      onIceCandidate: (candidate) => signal("call.signal", { signal: { kind: "candidate", candidate } }),
      onRemoteStream: (stream) => remoteStreamCb(stream),
      onConnectionState: onConnectionState,
    });
    const stream = media.getStream();
    if (stream) peer.addLocalStream(stream);
  }

  function onConnectionState(pcState) {
    if (pcState === "connected") {
      markConnected();
    } else if (pcState === "disconnected") {
      if (state === CallState.CONNECTED) enterReconnecting();
    } else if (pcState === "failed") {
      enterReconnecting();
      void tryIceRestart();
    }
  }

  function markConnected() {
    clearTimer("ring");
    clearTimer("reconnect");
    if (!connectedAt) connectedAt = Date.now();
    if (state !== CallState.CONNECTED) {
      setState(CallState.CONNECTED);
      startDuration();
    } else {
      emit();
    }
  }

  function enterReconnecting() {
    if (state === CallState.RECONNECTING) return;
    setState(CallState.RECONNECTING);
    clearTimer("reconnect");
    reconnectTimer = setTimeout(() => {
      if (state === CallState.RECONNECTING) {
        signal("call.end");
        endLocally({ reason: "connection-lost" });
      }
    }, RECONNECT_TIMEOUT_MS);
  }

  async function tryIceRestart() {
    if (role !== "caller" || iceRestartTried || !peer) return;
    iceRestartTried = true;
    try {
      const offer = await peer.createOffer({ iceRestart: true });
      signal("call.signal", { signal: { kind: "offer", description: offer } });
    } catch {
      /* the reconnect timer will end the call if this doesn't recover */
    }
  }

  /* -- Media acquisition -------------------------------------------------- */

  async function acquireMedia() {
    try {
      const stream = await media.acquire(mediaKind);
      micOn = media.setMic(true);
      camOn = mediaKind === "video" ? media.setCamera(true) : false;
      localStreamCb(stream);
      return true;
    } catch (err) {
      error = err?.code || "media-error";
      return false;
    }
  }

  /* -- Public: place a call (caller) -------------------------------------- */

  async function start(target, kind) {
    if (state !== CallState.IDLE || !target) return;
    reset(true);
    role = "caller";
    mediaKind = kind === "video" ? "video" : "audio";
    peerUser = { userId: target.userId, name: target.name, avatarUrl: target.avatarUrl ?? null };
    chatId = target.chatId;
    callId = crypto.randomUUID();
    setState(CallState.CALLING);

    if (!(await acquireMedia())) {
      endLocally({ reason: "media" });
      return;
    }
    await buildPeer();

    send({ type: "call.invite", callId, chatId, toUserId: peerUser.userId, media: mediaKind });

    ringTimer = setTimeout(() => {
      if (state === CallState.CALLING) {
        signal("call.cancel");
        endLocally({ reason: "no-answer" });
      }
    }, RING_TIMEOUT_MS);
  }

  /* -- Public: accept / decline (callee) ---------------------------------- */

  async function accept() {
    if (state !== CallState.INCOMING || !pendingInvite) return;
    role = "callee";
    callId = pendingInvite.callId;
    mediaKind = pendingInvite.media;
    chatId = pendingInvite.chatId;
    clearTimer("ring");

    if (!(await acquireMedia())) {
      signal("call.decline");
      endLocally({ reason: "media" });
      return;
    }
    await buildPeer();
    signal("call.accept");
    setState(CallState.CONNECTING);
    // The caller now sends its offer; handleSignal() will answer.
  }

  function decline() {
    if (state !== CallState.INCOMING) return;
    signal("call.decline");
    endLocally({ reason: "declined-by-me" });
  }

  /* -- Public: hang up ---------------------------------------------------- */

  function hangup() {
    if (state === CallState.IDLE || state === CallState.ENDED) return;
    if (state === CallState.INCOMING) {
      decline();
      return;
    }
    if (state === CallState.CALLING) signal("call.cancel");
    else signal("call.end");
    endLocally({ reason: "ended-by-me" });
  }

  /* -- Public: media controls -------------------------------------------- */

  function toggleMic() {
    micOn = media.setMic(!micOn);
    emit();
  }
  function toggleCamera() {
    if (!media.hasVideo()) return;
    camOn = media.setCamera(!camOn);
    emit();
  }
  async function switchCamera() {
    if (!media.hasVideo() || !peer) return;
    const track = await media.useNextCamera();
    if (!track) return;
    const sender = peer.senderFor("video");
    if (sender) await sender.replaceTrack(track);
    localStreamCb(media.getStream());
    emit();
  }
  async function switchMic() {
    if (!peer) return;
    const track = await media.useNextMicrophone();
    if (!track) return;
    const sender = peer.senderFor("audio");
    if (sender) await sender.replaceTrack(track);
    emit();
  }

  /* -- Incoming signaling ------------------------------------------------- */

  function handleEvent(ev) {
    switch (ev.type) {
      case "call.invite":
        return onInvite(ev);
      case "call.accept":
        return onAccept(ev);
      case "call.decline":
        return onRemoteTerminal(ev, "declined");
      case "call.cancel":
        return onRemoteTerminal(ev, "canceled");
      case "call.busy":
        return onRemoteTerminal(ev, "busy");
      case "call.unavailable":
        return onUnavailable(ev);
      case "call.end":
        return onRemoteTerminal(ev, ev.reason === "disconnected" ? "peer-disconnected" : "ended");
      case "call.signal":
        return void handleSignal(ev);
      default:
        return;
    }
  }

  function onInvite(ev) {
    // Already busy → politely reject with a busy signal.
    if (state !== CallState.IDLE) {
      send({ type: "call.busy", callId: ev.callId, toUserId: ev.fromUserId });
      return;
    }
    reset(true);
    role = "callee";
    mediaKind = ev.media;
    pendingInvite = { callId: ev.callId, fromUserId: ev.fromUserId, media: ev.media, chatId: ev.chatId };
    callId = ev.callId;
    const info = resolveUser(ev.fromUserId);
    peerUser = { userId: ev.fromUserId, name: info.name, avatarUrl: info.avatarUrl };
    setState(CallState.INCOMING);

    ringTimer = setTimeout(() => {
      if (state === CallState.INCOMING) {
        signal("call.decline");
        endLocally({ reason: "missed" });
      }
    }, RING_TIMEOUT_MS);
  }

  async function onAccept(ev) {
    if (ev.callId !== callId || role !== "caller") return;
    setState(CallState.CONNECTING);
    try {
      const offer = await peer.createOffer();
      signal("call.signal", { signal: { kind: "offer", description: offer } });
    } catch {
      signal("call.end");
      endLocally({ reason: "negotiation-failed" });
    }
  }

  function onUnavailable(ev) {
    if (ev.callId !== callId) return;
    endLocally({ reason: "unavailable" });
  }

  function onRemoteTerminal(ev, reason) {
    if (ev.callId !== callId) return;
    endLocally({ reason });
  }

  async function handleSignal(ev) {
    if (ev.callId !== callId || !peer) return;
    const { signal: s } = ev;
    try {
      if (s.kind === "offer") {
        await peer.setRemoteDescription(s.description);
        const answer = await peer.createAnswer();
        signal("call.signal", { signal: { kind: "answer", description: answer } });
      } else if (s.kind === "answer") {
        await peer.setRemoteDescription(s.description);
      } else if (s.kind === "candidate") {
        await peer.addRemoteCandidate(s.candidate);
      }
    } catch {
      /* malformed / out-of-order signaling — connection watchers handle failure */
    }
  }

  /* -- Teardown ----------------------------------------------------------- */

  function endLocally({ reason }) {
    if (ended) return;
    ended = true;
    endReason = reason;
    clearTimer("ring");
    clearTimer("reconnect");
    clearTimer("duration");
    if (peer) {
      peer.close();
      peer = null;
    }
    media.stop();
    localStreamCb(null);
    remoteStreamCb(null);
    setState(CallState.ENDED);

    endResetTimer = setTimeout(() => {
      reset(false);
      setState(CallState.IDLE);
    }, ENDED_LINGER_MS);
  }

  /** Reset all per-call context. `keepEnded=false` clears the ended latch too. */
  function reset(preserveNothing) {
    clearTimer("ring");
    clearTimer("reconnect");
    clearTimer("duration");
    clearTimer("endReset");
    callId = null;
    role = null;
    peerUser = null;
    pendingInvite = null;
    chatId = null;
    connectedAt = 0;
    micOn = true;
    camOn = false;
    iceRestartTried = false;
    ended = false;
    error = null;
    endReason = null;
    void preserveNothing;
  }

  function startDuration() {
    clearTimer("duration");
    durationTimer = setInterval(emit, 1000);
  }

  function clearTimer(which) {
    if (which === "ring" && ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
    if (which === "reconnect" && reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (which === "duration" && durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    if (which === "endReset" && endResetTimer) { clearTimeout(endResetTimer); endResetTimer = null; }
  }

  function destroy() {
    endLocally({ reason: "ended" });
    clearTimer("endReset");
    subscribers.clear();
  }

  /* -- Wiring ------------------------------------------------------------- */

  return {
    CallState,
    start,
    accept,
    decline,
    hangup,
    toggleMic,
    toggleCamera,
    switchCamera,
    switchMic,
    handleEvent,
    isBusy: () => state !== CallState.IDLE,
    subscribe(cb) {
      subscribers.add(cb);
      cb(snapshot());
      return () => subscribers.delete(cb);
    },
    onLocalStream(cb) { localStreamCb = cb; },
    onRemoteStream(cb) { remoteStreamCb = cb; },
    destroy,
  };
}
