/**
 * RelayOne Calls — public entry point.
 *
 * Wires two engines to their overlays and exposes a small facade the app shell
 * uses: start a 1:1 or group call, feed signaling events, ask if it's busy.
 * Everything call-related lives under this folder so screen share, PiP and
 * call-quality can be layered on without touching the chat code.
 */
import { createEngine } from "./engine.js";
import { createCallUI } from "./ui.js";
import { createGroupEngine } from "./groupEngine.js";
import { createGroupCallUI } from "./groupUi.js";

export function createCalls({ send, getMe, resolveUser, resolveChat, getIceServers }) {
  const engine = createEngine({ send, getMe, resolveUser, getIceServers });
  const ui = createCallUI(engine);
  engine.subscribe(ui.render);
  engine.onLocalStream(ui.setLocalStream);
  engine.onRemoteStream(ui.setRemoteStream);

  const group = createGroupEngine({ send, getMe, resolveUser, resolveChat, getIceServers });
  const groupUi = createGroupCallUI(group);
  group.subscribe(groupUi.render);
  group.onLocalStream(groupUi.setLocalStream);

  const isBusy = () => engine.isBusy() || group.isBusy();

  /** Route an incoming realtime `call.*` event to the right engine. */
  function handleEvent(ev) {
    if (!ev || typeof ev.type !== "string") return;

    // Group-specific events always go to the group engine.
    if (ev.type.startsWith("call.group-")) {
      // Don't ring a group invite while a 1:1 call is in progress.
      if (ev.type === "call.group-invite" && engine.isBusy()) return;
      return group.handleEvent(ev);
    }

    // Shared signalling: route by which engine owns the call id.
    if (ev.type === "call.signal") {
      if (group.ownsCall(ev.callId)) return group.handleEvent(ev);
      return engine.handleEvent(ev);
    }

    // A 1:1 invite arriving while a group call is active → politely reject.
    if (ev.type === "call.invite" && group.isBusy()) {
      send({ type: "call.busy", callId: ev.callId, toUserId: ev.fromUserId });
      return;
    }

    return engine.handleEvent(ev);
  }

  return {
    /** Place a 1:1 call to `peer` = { chatId, userId, name, avatarUrl }. */
    start: (peer, media) => engine.start(peer, media),
    /** Start a group call in `{ chatId, title, media }`. */
    startGroup: (opts) => {
      if (isBusy()) return;
      group.start(opts);
    },
    handleEvent,
    isBusy,
    destroy: () => {
      engine.destroy();
      ui.destroy();
      group.destroy();
      groupUi.destroy();
    },
  };
}
