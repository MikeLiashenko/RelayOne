/**
 * RelayOne Calls — RTCPeerConnection wrapper.
 *
 * A thin, transport-agnostic wrapper: it emits ICE candidates and the remote
 * stream via callbacks, buffers remote candidates that arrive before the
 * remote description, and exposes the offer/answer helpers the engine needs.
 * Keeping this isolated makes room for multiple peers (group calls) later.
 */
export function createPeer({ iceServers, onIceCandidate, onRemoteStream, onConnectionState }) {
  const pc = new RTCPeerConnection({ iceServers });
  const remoteStream = new MediaStream();
  const pendingCandidates = [];
  let remoteReady = false;

  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate) onIceCandidate(e.candidate.toJSON());
  });

  pc.addEventListener("track", (e) => {
    // Coalesce tracks into a single stream the UI can bind once.
    const incoming = e.streams[0];
    if (incoming) {
      incoming.getTracks().forEach((t) => addUnique(remoteStream, t));
    } else {
      addUnique(remoteStream, e.track);
    }
    onRemoteStream(remoteStream);
  });

  pc.addEventListener("connectionstatechange", () => onConnectionState(pc.connectionState));

  function addUnique(stream, track) {
    if (!stream.getTracks().some((t) => t.id === track.id)) stream.addTrack(track);
  }

  function addLocalStream(stream) {
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
  }

  function senderFor(kind) {
    return pc.getSenders().find((s) => s.track && s.track.kind === kind) ?? null;
  }

  async function createOffer(options) {
    const offer = await pc.createOffer(options);
    await pc.setLocalDescription(offer);
    return pc.localDescription;
  }

  async function createAnswer() {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return pc.localDescription;
  }

  async function setRemoteDescription(description) {
    await pc.setRemoteDescription(description);
    remoteReady = true;
    // Flush any candidates that raced ahead of the description.
    while (pendingCandidates.length) {
      const c = pendingCandidates.shift();
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore late/duplicate candidates */
      }
    }
  }

  async function addRemoteCandidate(candidate) {
    if (!remoteReady) {
      pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore late/duplicate candidates */
    }
  }

  function close() {
    try {
      pc.getSenders().forEach((s) => s.track && s.track.stop && s.track.stop());
    } catch {
      /* ignore */
    }
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }

  return {
    pc,
    addLocalStream,
    senderFor,
    createOffer,
    createAnswer,
    setRemoteDescription,
    addRemoteCandidate,
    close,
    connectionState: () => pc.connectionState,
  };
}
