import webpush from "web-push";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { pushSubscriptions } from "../db/schema";
import { env } from "../config/env";

/**
 * Web Push (VAPID) delivery.
 *
 * Push works only when a VAPID private key is configured — otherwise every send
 * is a silent no-op, so local dev and preview deploys run fine without it. The
 * public key is served to the browser so it can create a subscription; the
 * private key signs outgoing pushes and must stay secret.
 *
 * Stale endpoints (unsubscribed / expired) return 404/410 and are pruned.
 */

const enabled = Boolean(env.VAPID_PRIVATE_KEY);

if (enabled) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY as string
  );
}

export interface PushPayload {
  title: string;
  body: string;
  chatId?: string;
  url?: string;
  tag?: string;
}

export const pushService = {
  isEnabled(): boolean {
    return enabled;
  },

  publicKey(): string {
    return env.VAPID_PUBLIC_KEY;
  },

  /** Store (or move to this user) a browser push subscription. */
  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } }
  ): Promise<void> {
    await getDb()
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
  },

  async unsubscribe(endpoint: string): Promise<void> {
    await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  },

  /** Fire-and-forget a push to every device the user has registered. */
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!enabled) return;
    const rows = await getDb()
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    if (rows.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            body
          );
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // Endpoint is gone — drop it so we don't keep trying.
            await getDb()
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.endpoint, row.endpoint));
          }
          // Other errors (network, rate limit) are transient — ignore.
        }
      })
    );
  },
};
