/**
 * RelayOne Calls — group engine (mesh).
 *
 * A group call is a full mesh: every participant holds one RTCPeerConnection to
 * every other participant, all sharing one local media stream. There is no media
 * server, which keeps it free to host — the trade-off is that it's meant for
 * small groups (~2–5 people), since each participant uploads their stream once
 * per peer.
 *
 * Glare-free connection rule: when someone joins, the participants *already* in
 * the call create the offer; the newcomer only answers. Signals are addressed to
 * a specific peer via `toUserId`.
 *
 * UI-agnostic: emits immutable snapshots via `subscribe`, the local stream via
 * `onLocalStream`, and per-participant remote streams inside each snapshot.
 */
import { createMediaController } from "./media.js";
import { createPeer } from "./peer.js";

export const GroupCallState = {
  IDLE: "idle",
  RINGING: "ringing", // an incoming group invite is pending
  JOINING: "joining", // acquiring media
  ACTIVE: "active", // in the call
  ENDED: "ended",
};

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const ENDED_LINGER_MS = 1_600;

export function createGroupEngine({ send, getMe, resolveUser, resolveChat, getIceServers }) {
  const subscribers = new Set();
  let localStreamCb = () => {};

  let iceServers = null;
  const media = createMediaController();

  let state = GroupCallState.IDLE;
  let callId = null;
  let chatId = null;
  let mediaKind = "audio";
  let chatTitle = "";
  let micOn = true;
  let camOn = false;
  let connectedAt = 0;
  let ended = false;
  let pendingInvite = null; // { callId, chatId, media, fromUserId, inviterName }

  // userId -> { user:{name,avatarUrl}, peer, stream, connState }
  const peers = new Map();

  let durationTimer = null;
  let endResetTimer = null;

  /* -- Snapshots ---------------------------------------------------------- */

  function snapshot() {
    const me = getMe?.() || {};
    const inCall = state === GroupCallState.ACTIVE || state === GroupCallState.JOINING;
    return {
      state,
      callId,
      chatId,
      media: mediaKind,
      chatTitle,
      micOn,
      camOn,
      hasLocalVideo: media.hasVideo(),
      self: { name: me.displayName || "You", avatarUrl: me.avatarUrl ?? null },
      participants: [...peers.entries()].map(([userId, p]) => ({
        userId,
        name: p.user.name,
        avatarUrl: p.user.avatarUrl,
        stream: p.stream,
        connected: p.connState === "connected",
      })),
      count: peers.size + (inCall ? 1 : 0),
      durationMs: connectedAt ? Date.now() - connectedAt : 0,
      pendingInvite,
    };
  }
  function emit() {
    const s = snapshot();
    for (const cb of subscribers) cb(s);
  }
  function setState(next) {
    state = next;
    emit();
  }

  /* -- Helpers ------------------------------------------------------------ */

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

  async function acquireMedia() {
    try {
      const stream = await media.acquire(mediaKind);
      micOn = media.setMic(true);
      camOn = mediaKind === "video" ? media.setCamera(true) : false;
      localStreamCb(stream);
      return true;
    } catch {
      return false;
    }
  }

  function sendSignal(toUserId, signal) {
    send({ type: "call.signal", callId, toUserId, signal });
  }

  /** Create (or return) the peer connection to `userId`. */
  async function buildPeer(userId, initiator) {
    if (peers.has(userId)) return peers.get(userId);
    const servers = await ensureIce();
    const info = resolveUser(userId);
    const entry = {
      user: { name: info.name, avatarUrl: info.avatarUrl },
      peer: null,
      stream: null,
      connState: "new",
    };
    entry.peer = createPeer({
      iceServers: servers,
      stopTracksOnClose: false, // local tracks are shared across the mesh
      onIceCandidate: (candidate) => sendSignal(userId, { kind: "candidate", candidate }),
      onRemoteStream: (stream) => {
        entry.stream = stream;
        emit();
      },
      onConnectionState: (st) => {
        entry.connState = st;
        emit();
      },
    });
    const local = media.getStream();
    if (local) entry.peer.addLocalStream(local);
    peers.set(userId, entry);
    emit();

    if (initiator) {
      try {
        const offer = await entry.peer.createOffer();
        sendSignal(userId, { kind: "offer", description: offer });
      } catch {
        /* connection-state watcher / peer-left will clean up */
      }
    }
    return entry;
  }

  /* -- Public: start a group call ----------------------------------------- */

  async function start({ chatId: cid, title, media: kind }) {
    if (state !== GroupCallState.IDLE || !cid) return;
    reset();
    chatId = cid;
    chatTitle = title || "Group call";
    mediaKind = kind === "video" ? "video" : "audio";
    callId = crypto.randomUUID();
    setState(GroupCallState.JOINING);

    if (!(await acquireMedia())) {
      endLocally();
      return;
    }
    connectedAt = Date.now();
    startDuration();
    setState(GroupCallState.ACTIVE);
    send({ type: "call.group-start", callId, chatId, media: mediaKind });
  }

  /* -- Public: accept / decline an incoming invite ------------------------ */

  async function accept() {
    if (state !== GroupCallState.RINGING || !pendingInvite) return;
    callId = pendingInvite.callId;
    chatId = pendingInvite.chatId;
    mediaKind = pendingInvite.media;
    chatTitle = pendingInvite.inviterTitle || chatTitle || "Group call";
    pendingInvite = null;
    setState(GroupCallState.JOINING);

    if (!(await acquireMedia())) {
      endLocally();
      return;
    }
    connectedAt = Date.now();
    startDuration();
    setState(GroupCallState.ACTIVE);
    // The server replies with the current roster; existing peers then offer.
    send({ type: "call.group-join", callId });
  }

  function decline() {
    if (state !== GroupCallState.RINGING) return;
    pendingInvite = null;
    endLocally();
  }

  /* -- Public: leave ------------------------------------------------------ */

  function hangup() {
    if (state === GroupCallState.IDLE || state === GroupCallState.ENDED) return;
    if (state === GroupCallState.RINGING) {
      decline();
      return;
    }
    send({ type: "call.group-leave", callId });
    endLocally();
  }

  /* -- Public: media controls --------------------------------------------- */

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
    if (!media.hasVideo()) return;
    const track = await media.useNextCamera();
    if (!track) return;
    for (const { peer } of peers.values()) {
      const sender = peer.senderFor("video");
      if (sender) await sender.replaceTrack(track);
    }
    localStreamCb(media.getStream());
    emit();
  }

  /* -- Incoming events ---------------------------------------------------- */

  function ownsCall(id) {
    return Boolean(callId) && id === callId;
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "call.group-invite":
        return onInvite(ev);
      case "call.group-roster":
        return void onRoster(ev);
      case "call.group-peer-joined":
        return void onPeerJoined(ev);
      case "call.group-peer-left":
        return onPeerLeft(ev);
      case "call.signal":
        return void onSignal(ev);
      default:
        return;
    }
  }

  function onInvite(ev) {
    if (state !== GroupCallState.IDLE) return; // already busy elsewhere
    const inviter = resolveUser(ev.fromUserId);
    const chat = resolveChat ? resolveChat(ev.chatId) : null;
    callId = ev.callId; // so stray signals route here while ringing
    chatId = ev.chatId;
    chatTitle = chat?.title || "Group call";
    pendingInvite = {
      callId: ev.callId,
      chatId: ev.chatId,
      media: ev.media,
      fromUserId: ev.fromUserId,
      inviterName: inviter.name,
      inviterTitle: chat?.title,
    };
    setState(GroupCallState.RINGING);
  }

  async function onRoster(ev) {
    if (!ownsCall(ev.callId)) return;
    const meId = getMe()?.id;
    // We're the newcomer: prepare an (answerer) peer for each existing member.
    for (const peerId of ev.peers) {
      if (peerId === meId) continue;
      await buildPeer(peerId, false);
    }
  }

  async function onPeerJoined(ev) {
    if (!ownsCall(ev.callId)) return;
    if (ev.userId === getMe()?.id) return;
    // Someone joined after us → we initiate the offer to them.
    await buildPeer(ev.userId, true);
  }

  function onPeerLeft(ev) {
    if (!ownsCall(ev.callId)) return;
    const entry = peers.get(ev.userId);
    if (entry) {
      try {
        entry.peer.close();
      } catch {
        /* ignore */
      }
      peers.delete(ev.userId);
      emit();
    }
  }

  async function onSignal(ev) {
    if (!ownsCall(ev.callId)) return;
    const fromId = ev.fromUserId;
    // An offer may arrive for a peer we haven't built yet — answer it.
    const entry = peers.get(fromId) || (await buildPeer(fromId, false));
    const pc = entry.peer;
    const s = ev.signal;
    try {
      if (s.kind === "offer") {
        await pc.setRemoteDescription(s.description);
        const answer = await pc.createAnswer();
        sendSignal(fromId, { kind: "answer", description: answer });
      } else if (s.kind === "answer") {
        await pc.setRemoteDescription(s.description);
      } else if (s.kind === "candidate") {
        await pc.addRemoteCandidate(s.candidate);
      }
    } catch {
      /* malformed / out-of-order — connection watchers handle failure */
    }
  }

  /* -- Teardown ----------------------------------------------------------- */

  function endLocally() {
    if (ended) return;
    ended = true;
    clearTimer("duration");
    for (const { peer } of peers.values()) {
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
    peers.clear();
    media.stop();
    localStreamCb(null);
    setState(GroupCallState.ENDED);
    endResetTimer = setTimeout(() => {
      reset();
      setState(GroupCallState.IDLE);
    }, ENDED_LINGER_MS);
  }

  function reset() {
    clearTimer("duration");
    clearTimer("endReset");
    for (const { peer } of peers.values()) {
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
    peers.clear();
    callId = null;
    chatId = null;
    chatTitle = "";
    mediaKind = "audio";
    micOn = true;
    camOn = false;
    connectedAt = 0;
    ended = false;
    pendingInvite = null;
  }

  function startDuration() {
    clearTimer("duration");
    durationTimer = setInterval(emit, 1000);
  }
  function clearTimer(which) {
    if (which === "duration" && durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
    if (which === "endReset" && endResetTimer) {
      clearTimeout(endResetTimer);
      endResetTimer = null;
    }
  }

  function destroy() {
    endLocally();
    clearTimer("endReset");
    subscribers.clear();
  }

  return {
    GroupCallState,
    start,
    accept,
    decline,
    hangup,
    toggleMic,
    toggleCamera,
    switchCamera,
    handleEvent,
    ownsCall,
    isBusy: () => state !== GroupCallState.IDLE,
    subscribe(cb) {
      subscribers.add(cb);
      cb(snapshot());
      return () => subscribers.delete(cb);
    },
    onLocalStream(cb) {
      localStreamCb = cb;
    },
    destroy,
  };
}
