/**
 * RelayOne — per-chat lock (client-side PIN).
 *
 * A privacy screen, not encryption: the PIN (salted SHA-256, never the PIN
 * itself) is stored in localStorage on this device only. Messages still live on
 * the server; this just hides a chat behind a PIN locally. Unlocking lasts for
 * the session — a reload re-locks.
 */
const LS_KEY = "relayone.locks";
const unlocked = new Set(); // chatIds unlocked this session

function load() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function save(map) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return hex(new Uint8Array(buf));
}
function randSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return hex(a);
}

export const locks = {
  /** Does this chat have a PIN set? */
  isLocked(chatId) {
    return Boolean(load()[chatId]);
  },
  /** Is the chat openable right now (no lock, or unlocked this session)? */
  isOpen(chatId) {
    return !this.isLocked(chatId) || unlocked.has(chatId);
  },

  async setLock(chatId, pin) {
    const salt = randSalt();
    const hash = await sha256Hex(salt + pin);
    const map = load();
    map[chatId] = { salt, hash };
    save(map);
    unlocked.add(chatId); // just set it → open now
  },

  /** Verify a PIN; on success the chat stays open for the session. */
  async verify(chatId, pin) {
    const rec = load()[chatId];
    if (!rec) return true;
    const hash = await sha256Hex(rec.salt + pin);
    if (hash === rec.hash) {
      unlocked.add(chatId);
      return true;
    }
    return false;
  },

  /** Remove the lock entirely (allowed while the chat is already open). */
  removeLock(chatId) {
    const map = load();
    delete map[chatId];
    save(map);
    unlocked.delete(chatId);
  },

  /** Re-lock for the session (e.g. after removing). */
  relock(chatId) {
    unlocked.delete(chatId);
  },
};

export default locks;
