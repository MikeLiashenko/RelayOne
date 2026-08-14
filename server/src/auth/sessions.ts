import { and, eq, gt, isNull } from "drizzle-orm";
import { env } from "../config/env";
import { getDb } from "../db";
import { devices, sessions, users, type Session, type User } from "../db/schema";
import { generateToken, hashToken } from "./hashing";

/**
 * Session lifecycle. Sessions are per-device and independently revocable, so
 * an account can be signed in on many devices at once.
 */

export interface IssuedSession {
  token: string;
  session: Session;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  device?: { name?: string; platform?: string; pushToken?: string }
): Promise<IssuedSession> {
  const db = getDb();

  let deviceId: string | null = null;
  if (device) {
    const [dev] = await db
      .insert(devices)
      .values({
        userId,
        name: device.name ?? null,
        platform: device.platform ?? null,
        pushToken: device.pushToken ?? null,
      })
      .returning();
    deviceId = dev!.id;
  }

  const token = generateToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);

  const [session] = await db
    .insert(sessions)
    .values({ userId, deviceId, tokenHash, expiresAt })
    .returning();

  return { token, session: session!, expiresAt };
}

/** Resolve a bearer token to its live session + user, or null. */
export async function resolveSession(
  token: string
): Promise<{ session: Session; user: User } | null> {
  const db = getDb();
  const tokenHash = hashToken(token);

  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!session) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user) return null;

  await db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, session.id));

  return { session, user };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
