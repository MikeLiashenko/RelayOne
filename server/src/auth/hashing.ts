import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Cryptographic helpers for auth secrets.
 *
 * - Low-entropy secrets (verification codes) are salted + scrypt-hashed and
 *   compared in constant time.
 * - High-entropy secrets (session tokens) are stored as a fast SHA-256 digest
 *   so they can be looked up by hash without a per-row salt.
 *
 * Plaintext codes/tokens are never persisted.
 */

const SCRYPT_KEYLEN = 32;

export function hashSecret(secret: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifySecret(secret: string, hash: string, salt: string): boolean {
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Deterministic digest for session-token lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** URL-safe opaque token with ~256 bits of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Uniformly random numeric verification code, zero-padded. */
export function generateNumericCode(digits = 6): string {
  const upper = 10 ** digits;
  return String(randomInt(0, upper)).padStart(digits, "0");
}
