/**
 * RelayOne Calls — public entry point.
 *
 * Wires the engine (state machine) to the UI overlay and exposes a small facade
 * the app shell uses: start a call, feed it signaling events, ask if it's busy.
 * Everything call-related lives under this folder so group calls, screen share,
 * PiP and call-quality can be layered on without touching the chat code.
 */
import { createEngine } from "./engine.js";
import { createCallUI } from "./ui.js";

export function createCalls({ send, getMe, resolveUser, getIceServers }) {
  const engine = createEngine({ send, getMe, resolveUser, getIceServers });
  const ui = createCallUI(engine);

  engine.subscribe(ui.render);
  engine.onLocalStream(ui.setLocalStream);
  engine.onRemoteStream(ui.setRemoteStream);

  return {
    /** Place a call to `peer` = { chatId, userId, name, avatarUrl }. */
    start: (peer, media) => engine.start(peer, media),
    /** Feed an incoming `call.*` realtime event. */
    handleEvent: (ev) => engine.handleEvent(ev),
    /** True while a call is ringing/connecting/active. */
    isBusy: () => engine.isBusy(),
    destroy: () => {
      engine.destroy();
      ui.destroy();
    },
  };
}
