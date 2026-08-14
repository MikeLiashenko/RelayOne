/**
 * RelayOne Calls — local media controller.
 *
 * Owns the local MediaStream: acquiring it (with permission handling), toggling
 * mic/camera, cycling between input devices, and releasing everything on end.
 * Knows nothing about signaling or peer connections — the engine wires the
 * produced tracks onto the RTCPeerConnection.
 */
export function createMediaController() {
  let stream = null;
  let currentVideoDeviceId = null;
  let currentAudioDeviceId = null;

  /** Translate raw getUserMedia failures into stable, UI-friendly codes. */
  function classifyError(err) {
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "device-not-found";
    if (name === "NotReadableError") return "device-in-use";
    return "media-error";
  }

  async function acquire(media) {
    const wantVideo = media === "video";
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantVideo ? { facingMode: "user" } : false,
      });
    } catch (err) {
      const reason = classifyError(err);
      const e = new Error(reason);
      e.code = reason;
      throw e;
    }
    rememberDevices();
    return stream;
  }

  function rememberDevices() {
    const v = stream?.getVideoTracks()[0];
    const a = stream?.getAudioTracks()[0];
    currentVideoDeviceId = v?.getSettings?.().deviceId ?? currentVideoDeviceId;
    currentAudioDeviceId = a?.getSettings?.().deviceId ?? currentAudioDeviceId;
  }

  function micEnabled() {
    const t = stream?.getAudioTracks()[0];
    return t ? t.enabled : false;
  }
  function cameraEnabled() {
    const t = stream?.getVideoTracks()[0];
    return t ? t.enabled : false;
  }
  function hasVideo() {
    return Boolean(stream?.getVideoTracks()[0]);
  }

  function setMic(on) {
    const t = stream?.getAudioTracks()[0];
    if (t) t.enabled = on;
    return micEnabled();
  }
  function setCamera(on) {
    const t = stream?.getVideoTracks()[0];
    if (t) t.enabled = on;
    return cameraEnabled();
  }

  async function listDevices(kind) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === kind);
    } catch {
      return [];
    }
  }

  function pickNextDeviceId(devices, currentId) {
    if (devices.length < 2) return null;
    const idx = devices.findIndex((d) => d.deviceId === currentId);
    return devices[(idx + 1) % devices.length]?.deviceId ?? null;
  }

  /** Swap the camera to the next available one. Returns the new track or null. */
  async function useNextCamera() {
    const cams = await listDevices("videoinput");
    const nextId = pickNextDeviceId(cams, currentVideoDeviceId);
    if (!nextId) return null;
    return replaceVideoInput(nextId);
  }

  /** Swap the microphone to the next available one. Returns the new track or null. */
  async function useNextMicrophone() {
    const mics = await listDevices("audioinput");
    const nextId = pickNextDeviceId(mics, currentAudioDeviceId);
    if (!nextId) return null;
    return replaceAudioInput(nextId);
  }

  async function replaceVideoInput(deviceId) {
    const wasEnabled = cameraEnabled();
    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    });
    const newTrack = fresh.getVideoTracks()[0];
    if (!newTrack) return null;
    newTrack.enabled = wasEnabled;

    const old = stream?.getVideoTracks()[0];
    if (old) {
      stream.removeTrack(old);
      old.stop();
    }
    stream?.addTrack(newTrack);
    currentVideoDeviceId = deviceId;
    return newTrack;
  }

  async function replaceAudioInput(deviceId) {
    const wasEnabled = micEnabled();
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
    });
    const newTrack = fresh.getAudioTracks()[0];
    if (!newTrack) return null;
    newTrack.enabled = wasEnabled;

    const old = stream?.getAudioTracks()[0];
    if (old) {
      stream.removeTrack(old);
      old.stop();
    }
    stream?.addTrack(newTrack);
    currentAudioDeviceId = deviceId;
    return newTrack;
  }

  /** Stop every track and drop the stream — releases camera & microphone. */
  function stop() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    stream = null;
    currentVideoDeviceId = null;
    currentAudioDeviceId = null;
  }

  return {
    acquire,
    getStream: () => stream,
    micEnabled,
    cameraEnabled,
    hasVideo,
    setMic,
    setCamera,
    useNextCamera,
    useNextMicrophone,
    stop,
  };
}
