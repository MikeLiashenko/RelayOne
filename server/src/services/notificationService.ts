import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { notifications, type Notification } from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicNotification } from "../shared/serialize";
import type { PublicNotification } from "../shared/types";
import { hub } from "../realtime/hub";

export const notificationService = {
  async create(
    userId: string,
    input: {
      type: string;
      chatId?: string;
      messageId?: string;
      data?: Record<string, unknown>;
    }
  ): Promise<Notification> {
    const [row] = await getDb()
      .insert(notifications)
      .values({
        userId,
        type: input.type,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        data: input.data ?? null,
      })
      .returning();
    hub.sendToUser(userId, {
      type: "notification",
      notification: toPublicNotification(row!),
    });
    return row!;
  },

  async list(
    userId: string,
    opts: { limit: number; unreadOnly?: boolean }
  ): Promise<PublicNotification[]> {
    const conditions = [eq(notifications.userId, userId)];
    if (opts.unreadOnly) conditions.push(isNull(notifications.readAt));
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(opts.limit);
    return rows.map(toPublicNotification);
  },

  async markRead(notificationId: string, userId: string): Promise<void> {
    const [row] = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1);
    if (!row) throw AppError.notFound("Notification not found.");
    if (row.userId !== userId) throw AppError.forbidden();
    await getDb()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, notificationId));
  },

  async markAllRead(userId: string): Promise<void> {
    await getDb()
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  },
};
