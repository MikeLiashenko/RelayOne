import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  chatMembers,
  chats,
  spaceChannels,
  spaceMembers,
  spaces,
  users,
  type Chat,
  type SpaceRole,
} from "../db/schema";
import { AppError } from "../shared/errors";
import {
  toPublicSpace,
  toPublicSpaceChannel,
  toPublicUser,
} from "../shared/serialize";
import type {
  PublicSpace,
  PublicSpaceChannel,
  SpaceDetail,
} from "../shared/types";
import { hub } from "../realtime/hub";

/** Role ranking for permission checks (higher = more powerful). */
const RANK: Record<SpaceRole, number> = {
  owner: 3,
  admin: 2,
  moderator: 1,
  member: 0,
};

/** The channels every new Space starts with. */
const DEFAULT_CHANNELS: Array<{
  name: string;
  icon: string;
  kind: "text" | "announcement" | "voice";
}> = [
  { name: "general", icon: "💬", kind: "text" },
  { name: "announcements", icon: "📢", kind: "announcement" },
  { name: "photos", icon: "📸", kind: "text" },
  { name: "voice", icon: "🎙️", kind: "voice" },
  { name: "polls", icon: "📊", kind: "text" },
  { name: "calls", icon: "🔊", kind: "voice" },
];

/**
 * Spaces — communities with nested channels and a role hierarchy
 * (owner → admin → moderator → member). Each channel is backed by a normal
 * `chats` row, so all messaging (send, react, thread, poll, shared media, group
 * calls) works through the existing chat pipeline. Membership is mirrored into
 * every channel chat's `chat_members`, which keeps per-chat authorization and
 * realtime fan-out unchanged. This service owns Space-level authorization.
 */
export const spaceService = {
  async getRole(spaceId: string, userId: string): Promise<SpaceRole | null> {
    const [row] = await getDb()
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .limit(1);
    return row?.role ?? null;
  },

  /** Throws unless `userId` is a member; returns their role. */
  async assertMember(spaceId: string, userId: string): Promise<SpaceRole> {
    const role = await this.getRole(spaceId, userId);
    if (!role) throw AppError.forbidden("You are not a member of this Space.");
    return role;
  },

  async assertAtLeast(
    spaceId: string,
    userId: string,
    min: SpaceRole
  ): Promise<SpaceRole> {
    const role = await this.assertMember(spaceId, userId);
    if (RANK[role] < RANK[min]) {
      throw AppError.forbidden("You don’t have permission to do that in this Space.");
    }
    return role;
  },

  async memberIds(spaceId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, spaceId));
    return rows.map((r) => r.userId);
  },

  /** Create a Space, seed its default channels, and make the caller owner. */
  async createSpace(
    ownerId: string,
    input: { name: string; description?: string }
  ): Promise<SpaceDetail> {
    const db = getDb();
    const [space] = await db
      .insert(spaces)
      .values({ name: input.name, description: input.description ?? null, createdBy: ownerId })
      .returning();

    await db.insert(spaceMembers).values({ spaceId: space!.id, userId: ownerId, role: "owner" });

    for (let i = 0; i < DEFAULT_CHANNELS.length; i++) {
      const c = DEFAULT_CHANNELS[i]!;
      await this.insertChannel(space!.id, { ...c, position: i });
    }

    return this.getDetail(space!.id, ownerId);
  },

  /**
   * Create a channel row + its backing group chat, and add every current Space
   * member to that chat so messaging/realtime just works.
   */
  async insertChannel(
    spaceId: string,
    input: { name: string; icon?: string; kind: "text" | "announcement" | "voice"; position: number }
  ): Promise<PublicSpaceChannel> {
    const db = getDb();
    const [chat] = await db
      .insert(chats)
      .values({ type: "group", title: input.name, spaceId })
      .returning();

    const ids = await this.memberIds(spaceId);
    if (ids.length) {
      await db.insert(chatMembers).values(
        ids.map((userId) => ({ chatId: chat!.id, userId, role: "member" as const }))
      );
    }

    const [channel] = await db
      .insert(spaceChannels)
      .values({
        spaceId,
        chatId: chat!.id,
        name: input.name,
        icon: input.icon ?? null,
        kind: input.kind,
        position: input.position,
      })
      .returning();

    return toPublicSpaceChannel(channel!);
  },

  /** Add a channel to a Space (admin+), then notify members. */
  async createChannel(
    spaceId: string,
    userId: string,
    input: { name: string; icon?: string; kind: "text" | "announcement" | "voice" }
  ): Promise<PublicSpaceChannel> {
    await this.assertAtLeast(spaceId, userId, "admin");
    const existing = await getDb()
      .select({ id: spaceChannels.id })
      .from(spaceChannels)
      .where(eq(spaceChannels.spaceId, spaceId));
    const channel = await this.insertChannel(spaceId, { ...input, position: existing.length });
    await this.notify(spaceId);
    return channel;
  },

  /** Delete a channel (admin+). Its chat + messages cascade away. */
  async deleteChannel(channelId: string, userId: string): Promise<void> {
    const db = getDb();
    const [channel] = await db
      .select()
      .from(spaceChannels)
      .where(eq(spaceChannels.id, channelId))
      .limit(1);
    if (!channel) throw AppError.notFound("Channel not found.");
    await this.assertAtLeast(channel.spaceId, userId, "admin");

    const remaining = await db
      .select({ id: spaceChannels.id })
      .from(spaceChannels)
      .where(eq(spaceChannels.spaceId, channel.spaceId));
    if (remaining.length <= 1) {
      throw AppError.validation("A Space must keep at least one channel.");
    }

    // Deleting the backing chat cascades the channel row (chat_id FK) + messages.
    await db.delete(chats).where(eq(chats.id, channel.chatId));
    await this.notify(channel.spaceId);
  },

  /** Join a Space: add membership + backfill into every channel chat. */
  async join(spaceId: string, userId: string): Promise<SpaceDetail> {
    const db = getDb();
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    if (!space) throw AppError.notFound("Space not found.");

    if (!(await this.getRole(spaceId, userId))) {
      await db.insert(spaceMembers).values({ spaceId, userId, role: "member" });
      const channelChats = await db
        .select({ chatId: spaceChannels.chatId })
        .from(spaceChannels)
        .where(eq(spaceChannels.spaceId, spaceId));
      if (channelChats.length) {
        await db
          .insert(chatMembers)
          .values(
            channelChats.map((c) => ({ chatId: c.chatId, userId, role: "member" as const }))
          )
          .onConflictDoNothing();
      }
      await this.notify(spaceId);
    }
    return this.getDetail(spaceId, userId);
  },

  /** Leave a Space (owners must delete it instead). */
  async leave(spaceId: string, userId: string): Promise<void> {
    const role = await this.assertMember(spaceId, userId);
    if (role === "owner") {
      throw AppError.validation("The owner can’t leave — delete the Space instead.");
    }
    await this.removeMemberRows(spaceId, userId);
    await this.notify(spaceId);
  },

  /** Change a member's role (owner, or admin acting below themselves). */
  async setRole(
    spaceId: string,
    actorId: string,
    targetId: string,
    role: "admin" | "moderator" | "member"
  ): Promise<SpaceDetail> {
    const actorRole = await this.assertAtLeast(spaceId, actorId, "admin");
    if (targetId === actorId) throw AppError.validation("You can’t change your own role.");
    const targetRole = await this.getRole(spaceId, targetId);
    if (!targetRole) throw AppError.notFound("That person isn’t in this Space.");
    if (targetRole === "owner") throw AppError.forbidden("You can’t change the owner’s role.");
    // Admins can only act strictly below themselves (and can't mint new admins).
    if (RANK[actorRole] <= RANK[targetRole] && actorRole !== "owner") {
      throw AppError.forbidden("You can’t change the role of someone at or above your level.");
    }
    if (role === "admin" && actorRole !== "owner") {
      throw AppError.forbidden("Only the owner can make someone an admin.");
    }
    await getDb()
      .update(spaceMembers)
      .set({ role })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetId)));
    await this.notify(spaceId);
    return this.getDetail(spaceId, actorId);
  },

  /** Remove a member (admin+, strictly below the actor). */
  async kick(spaceId: string, actorId: string, targetId: string): Promise<void> {
    const actorRole = await this.assertAtLeast(spaceId, actorId, "admin");
    if (targetId === actorId) throw AppError.validation("Use “Leave” to remove yourself.");
    const targetRole = await this.getRole(spaceId, targetId);
    if (!targetRole) throw AppError.notFound("That person isn’t in this Space.");
    if (RANK[actorRole] <= RANK[targetRole]) {
      throw AppError.forbidden("You can’t remove someone at or above your level.");
    }
    await this.removeMemberRows(spaceId, targetId);
    await this.notify(spaceId);
  },

  /** Delete a whole Space (owner only). Channels/messages cascade away. */
  async deleteSpace(spaceId: string, userId: string): Promise<void> {
    const role = await this.assertMember(spaceId, userId);
    if (role !== "owner") throw AppError.forbidden("Only the owner can delete a Space.");
    const members = await this.memberIds(spaceId);
    await getDb().delete(spaces).where(eq(spaces.id, spaceId));
    hub.broadcastToUsers(members, { type: "space.updated", spaceId });
  },

  /** Spaces the user belongs to (for the Spaces rail). */
  async listForUser(userId: string): Promise<PublicSpace[]> {
    const db = getDb();
    const mine = await db
      .select()
      .from(spaceMembers)
      .where(eq(spaceMembers.userId, userId));
    if (mine.length === 0) return [];
    const spaceIds = mine.map((m) => m.spaceId);
    const spaceRows = await db.select().from(spaces).where(inArray(spaces.id, spaceIds));
    const roleBySpace = new Map(mine.map((m) => [m.spaceId, m.role]));

    const counts = await db
      .select({ spaceId: spaceMembers.spaceId, userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(inArray(spaceMembers.spaceId, spaceIds));
    const countBySpace = new Map<string, number>();
    for (const c of counts) countBySpace.set(c.spaceId, (countBySpace.get(c.spaceId) ?? 0) + 1);

    return spaceRows.map((s) =>
      toPublicSpace(s, {
        memberCount: countBySpace.get(s.id) ?? 0,
        myRole: roleBySpace.get(s.id) ?? null,
      })
    );
  },

  /** Full Space view (members must belong to it). */
  async getDetail(spaceId: string, userId: string): Promise<SpaceDetail> {
    const db = getDb();
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    if (!space) throw AppError.notFound("Space not found.");
    const myRole = await this.assertMember(spaceId, userId);

    const channelRows = await db
      .select()
      .from(spaceChannels)
      .where(eq(spaceChannels.spaceId, spaceId))
      .orderBy(spaceChannels.position);

    const memberRows = await db
      .select({ role: spaceMembers.role, joinedAt: spaceMembers.joinedAt, user: users })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, spaceId));

    return {
      ...toPublicSpace(space, { memberCount: memberRows.length, myRole }),
      channels: channelRows.map(toPublicSpaceChannel),
      members: memberRows
        .map((m) => ({
          user: toPublicUser(m.user),
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        }))
        .sort((a, b) => RANK[b.role] - RANK[a.role]),
    };
  },

  /**
   * Guard used by the message pipeline: only moderators+ may post in an
   * announcement channel. A no-op for non-Space chats and normal channels.
   */
  async assertCanPost(chat: Chat, userId: string): Promise<void> {
    if (!chat.spaceId) return;
    const [channel] = await getDb()
      .select()
      .from(spaceChannels)
      .where(eq(spaceChannels.chatId, chat.id))
      .limit(1);
    if (!channel || channel.kind !== "announcement") return;
    const role = await this.getRole(chat.spaceId, userId);
    if (!role || RANK[role] < RANK.moderator) {
      throw AppError.forbidden("Only moderators and admins can post in an announcement channel.");
    }
  },

  /** Remove a user's Space membership + their rows in every channel chat. */
  async removeMemberRows(spaceId: string, userId: string): Promise<void> {
    const db = getDb();
    await db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
    const channelChats = await db
      .select({ chatId: spaceChannels.chatId })
      .from(spaceChannels)
      .where(eq(spaceChannels.spaceId, spaceId));
    if (channelChats.length) {
      await db.delete(chatMembers).where(
        and(
          inArray(
            chatMembers.chatId,
            channelChats.map((c) => c.chatId)
          ),
          eq(chatMembers.userId, userId)
        )
      );
    }
  },

  /** Tell every current member to re-fetch this Space. */
  async notify(spaceId: string): Promise<void> {
    hub.broadcastToUsers(await this.memberIds(spaceId), { type: "space.updated", spaceId });
  },
};
