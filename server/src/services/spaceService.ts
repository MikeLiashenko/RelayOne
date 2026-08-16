import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db";
import {
  chatMembers,
  chats,
  messages,
  spaceChannels,
  spaceMemberRoles,
  spaceMembers,
  spaceRoles,
  spaces,
  users,
  SPACE_PERMISSIONS,
  type Chat,
  type SpaceChannelKind,
  type SpacePermission,
  type SpaceRole,
} from "../db/schema";
import { AppError } from "../shared/errors";
import {
  toPublicSpace,
  toPublicSpaceChannel,
  toPublicSpaceRole,
  toPublicUser,
} from "../shared/serialize";
import type {
  PublicSpace,
  PublicSpaceChannel,
  PublicSpaceRole,
  SpaceDetail,
} from "../shared/types";
import { hub } from "../realtime/hub";

/** Role ranking for permission checks (higher = more powerful). */
const RANK: Record<SpaceRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  contributor: 1,
  member: 0,
};
const rankOf = (role: string | null | undefined): number =>
  RANK[(role as SpaceRole) ?? "member"] ?? 0;

/** Permissions each built-in ladder role grants by default (owner ⇒ all). */
const BUILTIN_PERMS: Record<SpaceRole, SpacePermission[]> = {
  owner: [...SPACE_PERMISSIONS],
  admin: ["manage_space", "manage_channels", "manage_roles", "manage_members", "post_announcements"],
  moderator: ["post_announcements"],
  contributor: [],
  member: [],
};

type ChannelSeed = {
  name: string;
  icon: string;
  kind: SpaceChannelKind;
  category: string;
};

/**
 * The channels every new Space starts with, grouped into sidebar sections.
 * "Home" is a virtual view (not a channel), so it isn't seeded here.
 */
const DEFAULT_CHANNELS: ChannelSeed[] = [
  { name: "announcements", icon: "📢", kind: "announcement", category: "Overview" },
  { name: "general", icon: "💬", kind: "text", category: "Channels" },
  { name: "discussions", icon: "🧵", kind: "forum", category: "Channels" },
  { name: "media", icon: "📸", kind: "text", category: "Channels" },
  { name: "polls", icon: "📊", kind: "poll", category: "Channels" },
  { name: "lounge", icon: "🔊", kind: "voice", category: "Voice" },
  { name: "voice", icon: "🎙️", kind: "voice", category: "Voice" },
];

/** Slugify a name into a candidate @handle. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base || "space";
}

/** Default sidebar section for a channel when none is given. */
function sectionFor(category: string | undefined, kind: SpaceChannelKind): string {
  if (category && category.trim()) return category.trim().slice(0, 40);
  if (kind === "voice" || kind === "video") return "Voice";
  if (kind === "announcement") return "Overview";
  return "Channels";
}

/** Order sidebar sections predictably; unknown sections fall after the known ones. */
const SECTION_ORDER = ["Overview", "Channels", "Voice"];
function sectionRank(name: string): number {
  const i = SECTION_ORDER.indexOf(name);
  return i === -1 ? SECTION_ORDER.length : i;
}

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
    return (row?.role as SpaceRole) ?? null;
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
    if (rankOf(role) < RANK[min]) {
      throw AppError.forbidden("You don’t have permission to do that in this Space.");
    }
    return role;
  },

  /* -- Permissions ------------------------------------------------------- */

  /** A member's effective permissions: ladder defaults ∪ every custom role held. */
  async effectivePermissions(spaceId: string, userId: string): Promise<SpacePermission[]> {
    const role = await this.getRole(spaceId, userId);
    if (!role) return [];
    if (role === "owner") return [...SPACE_PERMISSIONS];
    const perms = new Set<SpacePermission>(BUILTIN_PERMS[role] ?? []);
    const rows = await getDb()
      .select({ permissions: spaceRoles.permissions })
      .from(spaceMemberRoles)
      .innerJoin(spaceRoles, eq(spaceRoles.id, spaceMemberRoles.roleId))
      .where(and(eq(spaceMemberRoles.spaceId, spaceId), eq(spaceMemberRoles.userId, userId)));
    for (const r of rows) {
      for (const p of r.permissions ?? []) {
        if ((SPACE_PERMISSIONS as readonly string[]).includes(p)) perms.add(p as SpacePermission);
      }
    }
    return [...perms];
  },

  async can(spaceId: string, userId: string, perm: SpacePermission): Promise<boolean> {
    return (await this.effectivePermissions(spaceId, userId)).includes(perm);
  },

  /** Throws 403 unless the user holds `perm` in this Space. */
  async assertCan(spaceId: string, userId: string, perm: SpacePermission): Promise<void> {
    if (!(await this.can(spaceId, userId, perm))) {
      throw AppError.forbidden("You don’t have permission to do that in this Space.");
    }
  },

  async memberIds(spaceId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, spaceId));
    return rows.map((r) => r.userId);
  },

  /** A free @handle derived from `desired` (or a name), suffixed if taken. */
  async freeHandle(desired: string): Promise<string> {
    const db = getDb();
    const base = slugify(desired);
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base}-${i}`;
      const [clash] = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.handle, candidate))
        .limit(1);
      if (!clash) return candidate;
    }
    return `${base}-${Math.floor(performance.now())}`;
  },

  /** Create a Space, seed its default channels, and make the caller owner. */
  async createSpace(
    ownerId: string,
    input: { name: string; description?: string; visibility?: "public" | "private" }
  ): Promise<SpaceDetail> {
    const db = getDb();
    const handle = await this.freeHandle(input.name);
    const [space] = await db
      .insert(spaces)
      .values({
        name: input.name,
        handle,
        description: input.description ?? null,
        visibility: input.visibility ?? "private",
        createdBy: ownerId,
      })
      .returning();

    await db.insert(spaceMembers).values({ spaceId: space!.id, userId: ownerId, role: "owner" });

    for (let i = 0; i < DEFAULT_CHANNELS.length; i++) {
      const c = DEFAULT_CHANNELS[i]!;
      await this.insertChannel(space!.id, { ...c, position: i });
    }

    return this.getDetail(space!.id, ownerId);
  },

  /** Edit a Space's object fields (admin+). Handle is validated for uniqueness. */
  async updateSpace(
    spaceId: string,
    userId: string,
    patch: {
      name?: string;
      handle?: string;
      description?: string | null;
      avatarUrl?: string | null;
      bannerUrl?: string | null;
      visibility?: "public" | "private";
    }
  ): Promise<SpaceDetail> {
    await this.assertCan(spaceId, userId, "manage_space");
    const db = getDb();
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
    if (patch.bannerUrl !== undefined) set.bannerUrl = patch.bannerUrl;
    if (patch.visibility !== undefined) set.visibility = patch.visibility;
    if (patch.handle !== undefined) {
      const slug = slugify(patch.handle);
      const [owner] = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.handle, slug))
        .limit(1);
      if (owner && owner.id !== spaceId) {
        throw AppError.validation("That handle is already taken.");
      }
      set.handle = slug;
    }
    if (Object.keys(set).length) {
      set.updatedAt = new Date();
      await db.update(spaces).set(set).where(eq(spaces.id, spaceId));
    }
    await this.notify(spaceId);
    return this.getDetail(spaceId, userId);
  },

  /**
   * Create a channel row + its backing group chat, and add every current Space
   * member to that chat so messaging/realtime just works.
   */
  async insertChannel(
    spaceId: string,
    input: {
      name: string;
      icon?: string;
      kind: SpaceChannelKind;
      category?: string;
      position: number;
    }
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
        category: sectionFor(input.category, input.kind),
        position: input.position,
      })
      .returning();

    return toPublicSpaceChannel(channel!);
  },

  /** Add a channel to a Space (admin+), then notify members. */
  async createChannel(
    spaceId: string,
    userId: string,
    input: { name: string; icon?: string; kind: SpaceChannelKind; category?: string }
  ): Promise<PublicSpaceChannel> {
    await this.assertCan(spaceId, userId, "manage_channels");
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
    await this.assertCan(channel.spaceId, userId, "manage_channels");

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
    role: "admin" | "moderator" | "contributor" | "member"
  ): Promise<SpaceDetail> {
    const actorRole = await this.assertMember(spaceId, actorId);
    await this.assertCan(spaceId, actorId, "manage_members");
    if (targetId === actorId) throw AppError.validation("You can’t change your own role.");
    const targetRole = await this.getRole(spaceId, targetId);
    if (!targetRole) throw AppError.notFound("That person isn’t in this Space.");
    if (targetRole === "owner") throw AppError.forbidden("You can’t change the owner’s role.");
    // Admins can only act strictly below themselves (and can't mint new admins).
    if (rankOf(actorRole) <= rankOf(targetRole) && actorRole !== "owner") {
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
    const actorRole = await this.assertMember(spaceId, actorId);
    await this.assertCan(spaceId, actorId, "manage_members");
    if (targetId === actorId) throw AppError.validation("Use “Leave” to remove yourself.");
    const targetRole = await this.getRole(spaceId, targetId);
    if (!targetRole) throw AppError.notFound("That person isn’t in this Space.");
    if (rankOf(actorRole) <= rankOf(targetRole)) {
      throw AppError.forbidden("You can’t remove someone at or above your level.");
    }
    await this.removeMemberRows(spaceId, targetId);
    await this.notify(spaceId);
  },

  /* -- Custom roles ------------------------------------------------------ */

  /** Keep only recognised permission strings. */
  cleanPerms(input: unknown): SpacePermission[] {
    if (!Array.isArray(input)) return [];
    const set = new Set<SpacePermission>();
    for (const p of input) {
      if ((SPACE_PERMISSIONS as readonly string[]).includes(p)) set.add(p as SpacePermission);
    }
    return [...set];
  },

  async createRole(
    spaceId: string,
    userId: string,
    input: { name: string; color?: string | null; permissions?: string[] }
  ): Promise<SpaceDetail> {
    await this.assertCan(spaceId, userId, "manage_roles");
    const db = getDb();
    const existing = await db
      .select({ id: spaceRoles.id })
      .from(spaceRoles)
      .where(eq(spaceRoles.spaceId, spaceId));
    await db.insert(spaceRoles).values({
      spaceId,
      name: input.name,
      color: input.color ?? null,
      permissions: this.cleanPerms(input.permissions),
      position: existing.length,
    });
    await this.notify(spaceId);
    return this.getDetail(spaceId, userId);
  },

  async updateRole(
    roleId: string,
    userId: string,
    patch: { name?: string; color?: string | null; permissions?: string[] }
  ): Promise<SpaceDetail> {
    const db = getDb();
    const [role] = await db.select().from(spaceRoles).where(eq(spaceRoles.id, roleId)).limit(1);
    if (!role) throw AppError.notFound("Role not found.");
    await this.assertCan(role.spaceId, userId, "manage_roles");
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.permissions !== undefined) set.permissions = this.cleanPerms(patch.permissions);
    if (Object.keys(set).length) {
      await db.update(spaceRoles).set(set).where(eq(spaceRoles.id, roleId));
    }
    await this.notify(role.spaceId);
    return this.getDetail(role.spaceId, userId);
  },

  async deleteRole(roleId: string, userId: string): Promise<void> {
    const db = getDb();
    const [role] = await db.select().from(spaceRoles).where(eq(spaceRoles.id, roleId)).limit(1);
    if (!role) throw AppError.notFound("Role not found.");
    await this.assertCan(role.spaceId, userId, "manage_roles");
    await db.delete(spaceRoles).where(eq(spaceRoles.id, roleId)); // assignments cascade
    await this.notify(role.spaceId);
  },

  /** Grant or revoke a custom role for a member. */
  async setRoleAssignment(
    spaceId: string,
    actorId: string,
    targetId: string,
    roleId: string,
    assign: boolean
  ): Promise<SpaceDetail> {
    await this.assertCan(spaceId, actorId, "manage_roles");
    const db = getDb();
    const [role] = await db
      .select()
      .from(spaceRoles)
      .where(and(eq(spaceRoles.id, roleId), eq(spaceRoles.spaceId, spaceId)))
      .limit(1);
    if (!role) throw AppError.notFound("Role not found.");
    if (!(await this.getRole(spaceId, targetId))) {
      throw AppError.notFound("That person isn’t in this Space.");
    }
    if (assign) {
      await db.insert(spaceMemberRoles).values({ spaceId, userId: targetId, roleId }).onConflictDoNothing();
    } else {
      await db
        .delete(spaceMemberRoles)
        .where(and(eq(spaceMemberRoles.roleId, roleId), eq(spaceMemberRoles.userId, targetId)));
    }
    await this.notify(spaceId);
    return this.getDetail(spaceId, actorId);
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
    const onlineBySpace = new Map<string, number>();
    for (const c of counts) {
      countBySpace.set(c.spaceId, (countBySpace.get(c.spaceId) ?? 0) + 1);
      if (hub.isOnline(c.userId)) {
        onlineBySpace.set(c.spaceId, (onlineBySpace.get(c.spaceId) ?? 0) + 1);
      }
    }

    return spaceRows.map((s) =>
      toPublicSpace(s, {
        memberCount: countBySpace.get(s.id) ?? 0,
        onlineCount: onlineBySpace.get(s.id) ?? 0,
        myRole: (roleBySpace.get(s.id) as SpaceRole) ?? null,
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

    const onlineCount = memberRows.filter((m) => hub.isOnline(m.user.id)).length;

    // Custom roles + their assignments (userId → [roleId]).
    const roleRows = await db
      .select()
      .from(spaceRoles)
      .where(eq(spaceRoles.spaceId, spaceId))
      .orderBy(spaceRoles.position);
    const assignments = await db
      .select()
      .from(spaceMemberRoles)
      .where(eq(spaceMemberRoles.spaceId, spaceId));
    const rolesByUser = new Map<string, string[]>();
    for (const a of assignments) {
      const arr = rolesByUser.get(a.userId) ?? [];
      arr.push(a.roleId);
      rolesByUser.set(a.userId, arr);
    }

    // Channels grouped: order by section, then position within the section.
    const channels = channelRows
      .map(toPublicSpaceChannel)
      .sort((a, b) => sectionRank(a.category) - sectionRank(b.category) || a.position - b.position);

    return {
      ...toPublicSpace(space, { memberCount: memberRows.length, onlineCount, myRole }),
      channels,
      members: memberRows
        .map((m) => ({
          user: toPublicUser(m.user),
          role: m.role as SpaceRole,
          customRoleIds: rolesByUser.get(m.user.id) ?? [],
          joinedAt: m.joinedAt.toISOString(),
        }))
        .sort((a, b) => rankOf(b.role) - rankOf(a.role)),
      roles: roleRows.map(toPublicSpaceRole),
      myPermissions: await this.effectivePermissions(spaceId, userId),
      latestAnnouncement: await this.latestAnnouncement(spaceId),
    };
  },

  /** Newest message posted in any announcement channel of the Space (for Home). */
  async latestAnnouncement(spaceId: string): Promise<SpaceDetail["latestAnnouncement"]> {
    const db = getDb();
    const announceChannels = await db
      .select()
      .from(spaceChannels)
      .where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.kind, "announcement")));
    if (announceChannels.length === 0) return null;

    const chatIds = announceChannels.map((c) => c.chatId);
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(inArray(messages.chatId, chatIds), isNull(messages.deletedAt)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (!msg) return null;

    const channel = announceChannels.find((c) => c.chatId === msg.chatId)!;
    const [sender] = await db.select().from(users).where(eq(users.id, msg.senderId)).limit(1);
    return {
      channelId: channel.id,
      chatId: msg.chatId,
      content: msg.content,
      senderId: msg.senderId,
      senderName: sender?.displayName ?? "Someone",
      createdAt: msg.createdAt.toISOString(),
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
    if (!(await this.can(chat.spaceId, userId, "post_announcements"))) {
      throw AppError.forbidden("You don’t have permission to post in an announcement channel.");
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
