import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../db";
import {
  attachments,
  chatMembers,
  chats,
  messageReactions,
  messages,
  type Attachment,
  type Message,
  type MessageReaction,
} from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicMessage } from "../shared/serialize";
import type { PublicMessage } from "../shared/types";
import { hub } from "../realtime/hub";
import { chatService } from "./chatService";
import { notificationService } from "./notificationService";

/**
 * Messages: create, list, edit, soft-delete, react. Every operation is
 * authorized against chat membership, and mutations fan out over realtime.
 */
export const messageService = {
  async hydrate(rows: Message[]): Promise<PublicMessage[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const db = getDb();

    const replyIds = [
      ...new Set(rows.map((r) => r.replyToId).filter((id): id is string => !!id)),
    ];

    const [atts, reacts, parents] = await Promise.all([
      db.select().from(attachments).where(inArray(attachments.messageId, ids)),
      db.select().from(messageReactions).where(inArray(messageReactions.messageId, ids)),
      replyIds.length
        ? db.select().from(messages).where(inArray(messages.id, replyIds))
        : Promise.resolve([] as Message[]),
    ]);

    const attByMsg = groupBy(atts, (a) => a.messageId ?? "");
    const reactByMsg = groupBy(reacts, (r) => r.messageId);
    const parentById = new Map(parents.map((p) => [p.id, p]));

    return rows.map((m) =>
      toPublicMessage(
        m,
        attByMsg.get(m.id) ?? [],
        reactByMsg.get(m.id) ?? [],
        m.replyToId ? parentById.get(m.replyToId) ?? null : null
      )
    );
  },

  async list(
    chatId: string,
    userId: string,
    opts: { limit: number; before?: string }
  ): Promise<PublicMessage[]> {
    await chatService.assertMember(chatId, userId);
    const conditions = [eq(messages.chatId, chatId)];
    if (opts.before) conditions.push(lt(messages.createdAt, new Date(opts.before)));

    const rows = await getDb()
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(opts.limit);

    // Return chronological (oldest → newest).
    return this.hydrate(rows.reverse());
  },

  /**
   * Global message search across every chat the user belongs to. Matches
   * message text case-insensitively; deleted messages are excluded. Returns
   * newest matches first (each carries its chatId so the client can jump to it).
   */
  async search(
    userId: string,
    q: string,
    opts: { limit: number }
  ): Promise<PublicMessage[]> {
    const term = q.trim();
    if (!term) return [];
    const db = getDb();

    const memberRows = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId));
    const chatIds = memberRows.map((r) => r.chatId);
    if (chatIds.length === 0) return [];

    // Escape LIKE wildcards so a literal % or _ in the query isn't a wildcard.
    const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          inArray(messages.chatId, chatIds),
          isNull(messages.deletedAt),
          ilike(messages.content, pattern)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(opts.limit);

    return this.hydrate(rows);
  },

  async getForUser(messageId: string, userId: string): Promise<Message> {
    const [message] = await getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!message) throw AppError.notFound("Message not found.");
    await chatService.assertMember(message.chatId, userId);
    return message;
  },

  async send(
    chatId: string,
    senderId: string,
    input: { content?: string; attachmentIds?: string[]; replyToId?: string }
  ): Promise<PublicMessage> {
    await chatService.assertMember(chatId, senderId);
    const db = getDb();

    // A reply must target a message in THIS chat (don't trust the client).
    if (input.replyToId) {
      const [parent] = await db
        .select({ id: messages.id, chatId: messages.chatId })
        .from(messages)
        .where(eq(messages.id, input.replyToId))
        .limit(1);
      if (!parent || parent.chatId !== chatId) {
        throw AppError.validation("You can only reply to a message in this chat.");
      }
    }

    const [message] = await db
      .insert(messages)
      .values({
        chatId,
        senderId,
        content: input.content ?? null,
        replyToId: input.replyToId ?? null,
      })
      .returning();

    // Link any pre-uploaded attachments owned by the sender and not yet used.
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await db
        .update(attachments)
        .set({ messageId: message!.id })
        .where(
          and(
            inArray(attachments.id, input.attachmentIds),
            eq(attachments.uploaderId, senderId),
            isNull(attachments.messageId)
          )
        );
    }

    await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

    const [full] = await this.hydrate([message!]);
    const memberIds = await chatService.getMemberIds(chatId);

    // Notify + broadcast to everyone in the chat.
    hub.broadcastToUsers(memberIds, { type: "message.new", message: full! });
    await Promise.all(
      memberIds
        .filter((id) => id !== senderId)
        .map((id) =>
          notificationService.create(id, {
            type: "message",
            chatId,
            messageId: message!.id,
          })
        )
    );

    return full!;
  },

  async edit(
    messageId: string,
    userId: string,
    content: string
  ): Promise<PublicMessage> {
    const message = await this.getForUser(messageId, userId);
    if (message.senderId !== userId) {
      throw AppError.forbidden("You can only edit your own messages.");
    }
    if (message.deletedAt) {
      throw AppError.validation("You can't edit a deleted message.");
    }

    const [updated] = await getDb()
      .update(messages)
      .set({ content, editedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning();

    const [full] = await this.hydrate([updated!]);
    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, { type: "message.edited", message: full! });
    return full!;
  },

  async remove(messageId: string, userId: string): Promise<void> {
    const message = await this.getForUser(messageId, userId);
    if (message.senderId !== userId) {
      throw AppError.forbidden("You can only delete your own messages.");
    }
    await getDb()
      .update(messages)
      .set({ deletedAt: new Date(), content: null })
      .where(eq(messages.id, messageId));

    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, {
      type: "message.deleted",
      chatId: message.chatId,
      messageId,
    });
  },

  /** Pin or unpin a message. Any member of the chat may (un)pin. */
  async setPinned(
    messageId: string,
    userId: string,
    pinned: boolean
  ): Promise<PublicMessage> {
    const message = await this.getForUser(messageId, userId);
    if (message.deletedAt) {
      throw AppError.validation("You can't pin a deleted message.");
    }

    const [updated] = await getDb()
      .update(messages)
      .set({
        pinnedAt: pinned ? new Date() : null,
        pinnedBy: pinned ? userId : null,
      })
      .where(eq(messages.id, messageId))
      .returning();

    const [full] = await this.hydrate([updated!]);
    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, {
      type: "message.pin",
      chatId: message.chatId,
      messageId,
      pinned,
      pinnedAt: full!.pinnedAt,
      by: userId,
    });
    return full!;
  },

  /** All pinned messages in a chat, newest pin first. */
  async listPinned(chatId: string, userId: string): Promise<PublicMessage[]> {
    await chatService.assertMember(chatId, userId);
    const rows = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), isNotNull(messages.pinnedAt)))
      .orderBy(desc(messages.pinnedAt));
    return this.hydrate(rows);
  },

  async addReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<void> {
    const message = await this.getForUser(messageId, userId);
    await getDb()
      .insert(messageReactions)
      .values({ messageId, userId, emoji })
      .onConflictDoNothing();
    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, {
      type: "message.reaction",
      chatId: message.chatId,
      messageId,
      emoji,
      userId,
      op: "add",
    });
  },

  async removeReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<void> {
    const message = await this.getForUser(messageId, userId);
    await getDb()
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji)
        )
      );
    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, {
      type: "message.reaction",
      chatId: message.chatId,
      messageId,
      emoji,
      userId,
      op: "remove",
    });
  },
};

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export type { Attachment, MessageReaction };
