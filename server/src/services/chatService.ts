import { and, count, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "../db";
import {
  chatMembers,
  chats,
  messages,
  users,
  type Chat,
  type User,
} from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicChat } from "../shared/serialize";
import type { ChatDetail, ChatSummary, PublicChat } from "../shared/types";
import { hub } from "../realtime/hub";

/**
 * Chats + membership. Group and direct chats share one model, so groups are a
 * natural extension rather than a separate architecture. Authorization lives
 * here: callers pass the acting user and are checked against membership.
 */
export const chatService = {
  async isMember(chatId: string, userId: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
      .limit(1);
    return Boolean(row);
  },

  /** Throws 403 unless `userId` is a member of `chatId`. Returns the chat. */
  async assertMember(chatId: string, userId: string): Promise<Chat> {
    const db = getDb();
    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!chat) throw AppError.notFound("Chat not found.");
    if (!(await this.isMember(chatId, userId))) {
      throw AppError.forbidden("You are not a member of this chat.");
    }
    return chat;
  },

  async getMemberIds(chatId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId));
    return rows.map((r) => r.userId);
  },

  async getMembers(chatId: string): Promise<User[]> {
    const ids = await this.getMemberIds(chatId);
    if (ids.length === 0) return [];
    return getDb().select().from(users).where(inArray(users.id, ids));
  },

  /** Distinct users who share at least one chat with `userId` (for presence). */
  async getPeerUserIds(userId: string): Promise<string[]> {
    const myChats = await getDb()
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId));
    const chatIds = myChats.map((c) => c.chatId);
    if (chatIds.length === 0) return [];
    const peers = await getDb()
      .selectDistinct({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(
        and(inArray(chatMembers.chatId, chatIds), ne(chatMembers.userId, userId))
      );
    return peers.map((p) => p.userId);
  },

  async findExistingDirect(
    userA: string,
    userB: string
  ): Promise<Chat | undefined> {
    // Direct chats have exactly the two members. Find candidate chats userA is
    // in, then check which is a direct chat also containing userB.
    const aChats = await getDb()
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userA));
    const ids = aChats.map((c) => c.chatId);
    if (ids.length === 0) return undefined;

    const candidates = await getDb()
      .select()
      .from(chats)
      .where(and(eq(chats.type, "direct"), inArray(chats.id, ids)));

    for (const chat of candidates) {
      const memberIds = await this.getMemberIds(chat.id);
      if (memberIds.length === 2 && memberIds.includes(userB)) return chat;
    }
    return undefined;
  },

  async createChat(input: {
    creatorId: string;
    type: "direct" | "group" | "channel";
    memberIds: string[];
    title?: string;
  }): Promise<PublicChat> {
    const db = getDb();
    const memberSet = new Set<string>([input.creatorId, ...input.memberIds]);

    // Validate every referenced user exists.
    const ids = [...memberSet];
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids));
    if (existing.length !== ids.length) {
      throw AppError.validation("One or more members do not exist.");
    }

    if (input.type === "direct") {
      const other = input.memberIds[0]!;
      if (other === input.creatorId) {
        throw AppError.validation("You can't start a direct chat with yourself.");
      }
      const found = await this.findExistingDirect(input.creatorId, other);
      if (found) return this.toPublic(found);
    }

    const [chat] = await db
      .insert(chats)
      .values({
        type: input.type,
        title: input.type === "direct" ? null : input.title ?? null,
        createdBy: input.creatorId,
      })
      .returning();

    await db.insert(chatMembers).values(
      ids.map((userId) => ({
        chatId: chat!.id,
        userId,
        role:
          userId === input.creatorId
            ? ("owner" as const)
            : ("member" as const),
      }))
    );

    return this.toPublic(chat!);
  },

  /** The user's private "Saved Messages" chat (a chat with only themselves). */
  async getOrCreateSaved(userId: string): Promise<PublicChat> {
    const db = getDb();
    const mine = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId));
    const ids = mine.map((r) => r.chatId);
    if (ids.length) {
      const [existing] = await db
        .select()
        .from(chats)
        .where(and(eq(chats.type, "saved"), inArray(chats.id, ids)))
        .limit(1);
      if (existing) return this.toPublic(existing);
    }

    const [chat] = await db
      .insert(chats)
      .values({ type: "saved", title: null, createdBy: userId })
      .returning();
    await db.insert(chatMembers).values({
      chatId: chat!.id,
      userId,
      role: "owner" as const,
    });
    return this.toPublic(chat!);
  },

  async listForUser(userId: string): Promise<PublicChat[]> {
    const rows = await getDb()
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId));
    const ids = rows.map((r) => r.chatId);
    if (ids.length === 0) return [];
    const chatRows = await getDb().select().from(chats).where(inArray(chats.id, ids));
    return Promise.all(chatRows.map((c) => this.toPublic(c)));
  },

  /** Chat-list rows with last message, unread count and peer presence. */
  async listSummariesForUser(userId: string): Promise<ChatSummary[]> {
    const db = getDb();
    const myRows = await db
      .select()
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId));
    if (myRows.length === 0) return [];

    const chatIds = myRows.map((r) => r.chatId);
    const chatRows = await db
      .select()
      .from(chats)
      .where(inArray(chats.id, chatIds));

    const memberRows = await db
      .select({ chatId: chatMembers.chatId, user: users })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(inArray(chatMembers.chatId, chatIds));

    const membersByChat = new Map<string, User[]>();
    for (const row of memberRows) {
      const arr = membersByChat.get(row.chatId) ?? [];
      arr.push(row.user);
      membersByChat.set(row.chatId, arr);
    }
    const myStateByChat = new Map(myRows.map((r) => [r.chatId, r]));

    const summaries = await Promise.all(
      chatRows.map(async (chat) => {
        const members = membersByChat.get(chat.id) ?? [];
        const myState = myStateByChat.get(chat.id);

        const [last] = await db
          .select()
          .from(messages)
          .where(eq(messages.chatId, chat.id))
          .orderBy(desc(messages.createdAt))
          .limit(1);

        const unreadConds = [
          eq(messages.chatId, chat.id),
          ne(messages.senderId, userId),
          isNull(messages.deletedAt),
        ];
        if (myState?.lastReadAt) {
          unreadConds.push(gt(messages.createdAt, myState.lastReadAt));
        }
        const unreadRows = await db
          .select({ c: count() })
          .from(messages)
          .where(and(...unreadConds));
        const unreadCount = Number(unreadRows[0]?.c ?? 0);

        const online = members.some(
          (m) => m.id !== userId && hub.isOnline(m.id)
        );

        return {
          ...toPublicChat(chat, members),
          lastMessage: last
            ? {
                id: last.id,
                senderId: last.senderId,
                content: last.deletedAt ? null : last.content,
                createdAt: last.createdAt.toISOString(),
                deletedAt: last.deletedAt ? last.deletedAt.toISOString() : null,
              }
            : null,
          unreadCount,
          online,
        } satisfies ChatSummary;
      })
    );

    summaries.sort((a, b) => summaryTime(b) - summaryTime(a));
    return summaries;
  },

  /** Full chat with per-member read + presence state. */
  async getDetail(chatId: string, userId: string): Promise<ChatDetail> {
    const chat = await this.assertMember(chatId, userId);
    const db = getDb();
    const rows = await db
      .select()
      .from(chatMembers)
      .where(eq(chatMembers.chatId, chatId));
    const members = await this.getMembers(chatId);
    return {
      ...toPublicChat(chat, members),
      memberStates: rows.map((r) => ({
        userId: r.userId,
        lastReadMessageId: r.lastReadMessageId,
        lastReadAt: r.lastReadAt ? r.lastReadAt.toISOString() : null,
        online: hub.isOnline(r.userId),
      })),
    };
  },

  async markRead(
    chatId: string,
    userId: string,
    messageId: string
  ): Promise<void> {
    await getDb()
      .update(chatMembers)
      .set({ lastReadMessageId: messageId, lastReadAt: new Date() })
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
  },

  async toPublic(chat: Chat): Promise<PublicChat> {
    const members = await this.getMembers(chat.id);
    return toPublicChat(chat, members);
  },
};

function summaryTime(s: ChatSummary): number {
  return Date.parse(s.lastMessage?.createdAt ?? s.updatedAt);
}
