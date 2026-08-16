import { and, eq, isNull, lte } from "drizzle-orm";
import { getDb } from "../db";
import { messages, scheduledMessages, type ScheduledMessage } from "../db/schema";
import { AppError } from "../shared/errors";
import { hub } from "../realtime/hub";
import { chatService } from "./chatService";
import { messageService } from "./messageService";

/**
 * Scheduler for two time-based features:
 *   • Scheduled messages — queued now, sent automatically at `sendAt`.
 *   • Self-destruct messages — auto-deleted once `messages.expiresAt` passes.
 *
 * A single interval (`start`) polls for due work. On the free single-instance
 * host this is enough; each due row is claimed atomically before sending so an
 * overlapping tick can't double-send.
 */

let timer: ReturnType<typeof setInterval> | null = null;

export interface PublicScheduledMessage {
  id: string;
  chatId: string;
  content: string | null;
  sendAt: string;
  ttlSeconds: number | null;
}

function toPublic(r: ScheduledMessage): PublicScheduledMessage {
  return {
    id: r.id,
    chatId: r.chatId,
    content: r.content,
    sendAt: r.sendAt.toISOString(),
    ttlSeconds: r.ttlSeconds ?? null,
  };
}

export const schedulerService = {
  async schedule(
    chatId: string,
    senderId: string,
    input: { content: string; sendAt: Date; ttlSeconds?: number; replyToId?: string }
  ): Promise<PublicScheduledMessage> {
    await chatService.assertMember(chatId, senderId);
    if (input.sendAt.getTime() <= Date.now()) {
      throw AppError.validation("Pick a time in the future.");
    }
    const [row] = await getDb()
      .insert(scheduledMessages)
      .values({
        chatId,
        senderId,
        content: input.content,
        replyToId: input.replyToId ?? null,
        ttlSeconds: input.ttlSeconds ?? null,
        sendAt: input.sendAt,
      })
      .returning();
    return toPublic(row!);
  },

  /** The caller's pending scheduled messages in a chat. */
  async listForChat(chatId: string, userId: string): Promise<PublicScheduledMessage[]> {
    await chatService.assertMember(chatId, userId);
    const rows = await getDb()
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.chatId, chatId),
          eq(scheduledMessages.senderId, userId),
          isNull(scheduledMessages.sentAt),
          isNull(scheduledMessages.canceledAt)
        )
      )
      .orderBy(scheduledMessages.sendAt);
    return rows.map(toPublic);
  },

  async cancel(id: string, userId: string): Promise<void> {
    const [row] = await getDb()
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, id))
      .limit(1);
    if (!row) throw AppError.notFound("Scheduled message not found.");
    if (row.senderId !== userId) throw AppError.forbidden();
    if (row.sentAt || row.canceledAt) return;
    await getDb()
      .update(scheduledMessages)
      .set({ canceledAt: new Date() })
      .where(eq(scheduledMessages.id, id));
  },

  /** One pass: send due scheduled messages, then delete expired ones. */
  async tick(): Promise<void> {
    await this.sendDue();
    await this.sweepExpired();
  },

  async sendDue(): Promise<void> {
    const db = getDb();
    const due = await db
      .select()
      .from(scheduledMessages)
      .where(
        and(
          lte(scheduledMessages.sendAt, new Date()),
          isNull(scheduledMessages.sentAt),
          isNull(scheduledMessages.canceledAt)
        )
      );
    for (const row of due) {
      try {
        // Claim it first so an overlapping tick can't send it twice.
        const claimed = await db
          .update(scheduledMessages)
          .set({ sentAt: new Date() })
          .where(and(eq(scheduledMessages.id, row.id), isNull(scheduledMessages.sentAt)))
          .returning({ id: scheduledMessages.id });
        if (claimed.length === 0) continue;
        await messageService.send(row.chatId, row.senderId, {
          content: row.content ?? undefined,
          replyToId: row.replyToId ?? undefined,
          ttlSeconds: row.ttlSeconds ?? undefined,
        });
      } catch {
        /* a bad row (e.g. left chat) shouldn't stall the whole queue */
      }
    }
  },

  async sweepExpired(): Promise<void> {
    const db = getDb();
    const expired = await db
      .select()
      .from(messages)
      .where(and(lte(messages.expiresAt, new Date()), isNull(messages.deletedAt)));
    for (const m of expired) {
      await db
        .update(messages)
        .set({ deletedAt: new Date(), content: null })
        .where(eq(messages.id, m.id));
      const memberIds = await chatService.getMemberIds(m.chatId);
      hub.broadcastToUsers(memberIds, {
        type: "message.deleted",
        chatId: m.chatId,
        messageId: m.id,
      });
    }
  },

  start(intervalMs = 20_000): void {
    if (timer) return;
    timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  },

  stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
};
