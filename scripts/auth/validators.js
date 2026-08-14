/**
 * RelayOne — Auth validators & formatting helpers
 *
 * Pure functions only: no DOM, no side effects. Kept separate from the auth
 * service so both the UI and a future real backend can share the same rules.
 */

/* -- Email ----------------------------------------------------------------- */

export function isValidEmail(value) {
  const v = String(value).trim();
  // Deliberately pragmatic: one @, a dotted domain, no whitespace.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/* -- Phone ----------------------------------------------------------------- */

/** Strip everything except digits and a single leading "+". */
export function normalizePhone(value) {
  const raw = String(value).trim();
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  return (hasPlus ? "+" : "") + digits;
}

export function isValidPhone(value) {
  const n = normalizePhone(value);
  // E.164-ish: optional +, first digit 1–9, 8–15 total digits.
  return /^\+?[1-9]\d{7,14}$/.test(n);
}

/* -- Username -------------------------------------------------------------- */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** Must start with a letter, then letters / digits / underscore. */
export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/;

export function isValidUsername(value) {
  return USERNAME_RE.test(String(value));
}

export const USERNAME_HINT =
  "3–20 characters — letters, numbers or underscores, starting with a letter.";

/* -- Display name ---------------------------------------------------------- */

export function isValidDisplayName(value) {
  const t = String(value).trim();
  return t.length >= 1 && t.length <= 50;
}

/* -- Destination masking (verification screen) ----------------------------- */

const DOT = "•";

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return email;

  const maskedUser =
    user.length <= 2
      ? user[0] + DOT
      : user[0] + DOT.repeat(Math.min(user.length - 2, 4)) + user.slice(-1);

  const parts = domain.split(".");
  const host = parts[0];
  const maskedHost = host[0] + DOT.repeat(Math.min(Math.max(host.length - 1, 1), 4));

  return `${maskedUser}@${maskedHost}.${parts.slice(1).join(".")}`;
}

function maskPhone(phone) {
  const n = normalizePhone(phone);
  const head = n.slice(0, n.startsWith("+") ? 3 : 2);
  const tail = n.slice(-2);
  return `${head} ${DOT}${DOT}${DOT} ${DOT}${DOT} ${tail}`;
}

/**
 * @param {"phone"|"email"} channel
 * @param {string} identifier
 * @returns {string} human-readable masked destination
 */
export function maskDestination(channel, identifier) {
  return channel === "email" ? maskEmail(identifier) : maskPhone(identifier);
}
