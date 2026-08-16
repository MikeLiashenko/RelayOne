import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "../db";
import {
  attachments,
  chatMembers,
  chats,
  messageEdits,
  messageReactions,
  messages,
  pollOptions,
  pollVotes,
  polls,
  users,
  type Attachment,
  type Message,
  type MessageReaction,
} from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicAttachment, toPublicMessage, toPublicPoll } from "../shared/serialize";
import type { PublicMessage } from "../shared/types";
import { hub } from "../realtime/hub";
import { chatService } from "./chatService";
import { notificationService } from "./notificationService";
import { pushService } from "./pushService";

/**
 * Messages: create, list, edit, soft-delete, react. Every operation is
 * authorized against chat membership, and mutations fan out over realtime.
 */
export const messageService = {
  async hydrate(rows: Message[], viewerId?: string): Promise<PublicMessage[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const db = getDb();

    const replyIds = [
      ...new Set(rows.map((r) => r.replyToId).filter((id): id is string => !!id)),
    ];

    // Load any polls attached to these messages, with their options + votes.
    const pollRows = await db.select().from(polls).where(inArray(polls.messageId, ids));
    const pollByMsg = new Map<string, ReturnType<typeof toPublicPoll>>();
    if (pollRows.length) {
      const pollIds = pollRows.map((p) => p.id);
      const [opts, pvotes] = await Promise.all([
        db.select().from(pollOptions).where(inArray(pollOptions.pollId, pollIds)),
        db.select().from(pollVotes).where(inArray(pollVotes.pollId, pollIds)),
      ]);
      for (const p of pollRows) {
        pollByMsg.set(p.messageId, toPublicPoll(p, opts, pvotes, viewerId));
      }
    }

    const [atts, reacts, parents, replyCounts] = await Promise.all([
      db.select().from(attachments).where(inArray(attachments.messageId, ids)),
      db.select().from(messageReactions).where(inArray(messageReactions.messageId, ids)),
      replyIds.length
        ? db.select().from(messages).where(inArray(messages.id, replyIds))
        : Promise.resolve([] as Message[]),
      // How many (non-deleted) replies each of these messages has — the thread size.
      db
        .select({ pid: messages.replyToId, c: count() })
        .from(messages)
        .where(and(inArray(messages.replyToId, ids), isNull(messages.deletedAt)))
        .groupBy(messages.replyToId),
    ]);

    const attByMsg = groupBy(atts, (a) => a.messageId ?? "");
    const reactByMsg = groupBy(reacts, (r) => r.messageId);
    const parentById = new Map(parents.map((p) => [p.id, p]));
    const countByMsg = new Map(replyCounts.map((r) => [r.pid, Number(r.c)]));

    return rows.map((m) => {
      const pm = toPublicMessage(
        m,
        attByMsg.get(m.id) ?? [],
        reactByMsg.get(m.id) ?? [],
        m.replyToId ? parentById.get(m.replyToId) ?? null : null,
        countByMsg.get(m.id) ?? 0
      );
      const poll = pollByMsg.get(m.id);
      if (poll) pm.poll = poll;
      return pm;
    });
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
    return this.hydrate(rows.reverse(), userId);
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

    return this.hydrate(rows, userId);
  },

  /**
   * Shared media/files/links/voice in a chat — powers the per-chat "Shared"
   * tabs. Returns newest first, capped at 100.
   */
  async listShared(
    chatId: string,
    userId: string,
    type: "media" | "files" | "links" | "voice"
  ): Promise<Array<Record<string, unknown>>> {
    await chatService.assertMember(chatId, userId);
    const db = getDb();

    if (type === "links") {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            isNull(messages.deletedAt),
            ilike(messages.content, "%http%")
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(100);
      const items: Array<Record<string, unknown>> = [];
      for (const m of rows) {
        for (const url of extractUrls(m.content ?? "")) {
          items.push({ url, messageId: m.id, createdAt: m.createdAt.toISOString() });
          if (items.length >= 100) break;
        }
        if (items.length >= 100) break;
      }
      return items;
    }

    const kinds =
      type === "media" ? ["image", "video"] : type === "voice" ? ["voice"] : ["document"];
    const rows = await db
      .select({ a: attachments, ts: messages.createdAt })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .where(
        and(
          eq(messages.chatId, chatId),
          isNull(messages.deletedAt),
          inArray(attachments.kind, kinds as Array<"image" | "video" | "document" | "voice">)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(100);
    return rows.map((r) => ({
      ...toPublicAttachment(r.a),
      messageId: r.a.messageId,
      createdAt: r.ts.toISOString(),
    }));
  },

  /** A message and all of its (non-deleted) replies — the thread view. */
  async listThread(
    messageId: string,
    userId: string
  ): Promise<{ parent: PublicMessage; replies: PublicMessage[] }> {
    const parent = await this.getForUser(messageId, userId); // authorizes membership
    const replyRows = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.replyToId, messageId), isNull(messages.deletedAt)))
      .orderBy(messages.createdAt);
    const [parentPublic] = await this.hydrate([parent], userId);
    const replies = await this.hydrate(replyRows, userId);
    return { parent: parentPublic!, replies };
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
    input: {
      content?: string;
      attachmentIds?: string[];
      replyToId?: string;
      ttlSeconds?: number;
    }
  ): Promise<PublicMessage> {
    await chatService.assertMember(chatId, senderId);
    const db = getDb();
    const expiresAt =
      input.ttlSeconds && input.ttlSeconds > 0
        ? new Date(Date.now() + input.ttlSeconds * 1000)
        : null;

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
        expiresAt,
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

    const [full] = await this.hydrate([message!], senderId);
    const memberIds = await chatService.getMemberIds(chatId);

    // Notify + broadcast to everyone in the chat.
    hub.broadcastToUsers(memberIds, { type: "message.new", message: full! });
    const others = memberIds.filter((id) => id !== senderId);
    await Promise.all(
      others.map((id) =>
        notificationService.create(id, {
          type: "message",
          chatId,
          messageId: message!.id,
        })
      )
    );

    // Web push for members who aren't currently connected (tab/app closed).
    const offline = others.filter((id) => !hub.isOnline(id));
    if (offline.length > 0) void this.pushOffline(offline, chatId, senderId, full!);

    return full!;
  },

  /** Fire-and-forget web-push to offline recipients of a new message. */
  async pushOffline(
    userIds: string[],
    chatId: string,
    senderId: string,
    msg: PublicMessage
  ): Promise<void> {
    if (!pushService.isEnabled()) return;
    const db = getDb();
    const [[sender], [chat]] = await Promise.all([
      db.select().from(users).where(eq(users.id, senderId)).limit(1),
      db.select().from(chats).where(eq(chats.id, chatId)).limit(1),
    ]);
    const senderName = sender?.displayName || "Someone";
    const isGroup = Boolean(chat && chat.type !== "direct");
    const raw = msg.content
      ? msg.content
      : msg.attachments?.length
        ? "📎 Attachment"
        : "New message";
    const preview = raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
    const payload = {
      title: isGroup ? chat?.title || "Group" : senderName,
      body: isGroup ? `${senderName}: ${preview}` : preview,
      chatId,
      tag: chatId,
      url: `app.html?chat=${chatId}`,
    };
    for (const id of userIds) void pushService.sendToUser(id, payload);
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
    if (content === message.content) return (await this.hydrate([message], userId))[0]!;

    const db = getDb();
    // Snapshot the version being replaced, so the full edit history is kept.
    await db.insert(messageEdits).values({
      messageId,
      content: message.content,
      editedAt: message.editedAt ?? message.createdAt,
    });

    const [updated] = await db
      .update(messages)
      .set({ content, editedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning();

    const [full] = await this.hydrate([updated!], userId);
    const memberIds = await chatService.getMemberIds(message.chatId);
    hub.broadcastToUsers(memberIds, { type: "message.edited", message: full! });
    return full!;
  },

  /** Edit history (oldest → newest), with the current version appended last. */
  async editHistory(
    messageId: string,
    userId: string
  ): Promise<Array<{ content: string | null; editedAt: string }>> {
    const message = await this.getForUser(messageId, userId);
    const edits = await getDb()
      .select()
      .from(messageEdits)
      .where(eq(messageEdits.messageId, messageId))
      .orderBy(messageEdits.editedAt);
    const versions = edits.map((e) => ({
      content: e.content,
      editedAt: e.editedAt.toISOString(),
    }));
    versions.push({
      content: message.deletedAt ? null : message.content,
      editedAt: (message.editedAt ?? message.createdAt).toISOString(),
    });
    return versions;
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

    const [full] = await this.hydrate([updated!], userId);
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
    return this.hydrate(rows, userId);
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

/** Extract http(s) URLs from message text (for the Shared → Links tab). */
function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
}

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
