import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { getDb } from "../db";
import {
  chatMembers,
  chats,
  messages,
  spaceChannels,
  spaceEventRsvps,
  spaceEvents,
  spaceInvites,
  spaceMemberRoles,
  spaceMembers,
  spaceRoles,
  spaces,
  users,
  SPACE_PERMISSIONS,
  type Chat,
  type SpaceChannelKind,
  type SpaceEvent,
  type SpacePermission,
  type SpaceRole,
} from "../db/schema";
import { AppError } from "../shared/errors";
import {
  toPublicSpace,
  toPublicSpaceChannel,
  toPublicSpaceEvent,
  toPublicSpaceInvite,
  toPublicSpaceRole,
  toPublicUser,
} from "../shared/serialize";
import type {
  PublicSpace,
  PublicSpaceChannel,
  PublicSpaceEvent,
  PublicSpaceInvite,
  PublicSpaceRole,
  SpaceDetail,
} from "../shared/types";
import { hub } from "../realtime/hub";
import { notificationService } from "./notificationService";

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

/** A short, unambiguous invite code (no 0/O/1/I/l). */
function genCode(len = 8): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += A[b[i]! % A.length];
  return s;
}

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

  /**
   * Add a user to a Space (idempotent): membership + backfill into every
   * channel chat. Returns true only if they were newly added.
   */
  async addMember(spaceId: string, userId: string): Promise<boolean> {
    if (await this.getRole(spaceId, userId)) return false;
    const db = getDb();
    await db.insert(spaceMembers).values({ spaceId, userId, role: "member" });
    const channelChats = await db
      .select({ chatId: spaceChannels.chatId })
      .from(spaceChannels)
      .where(eq(spaceChannels.spaceId, spaceId));
    if (channelChats.length) {
      await db
        .insert(chatMembers)
        .values(channelChats.map((c) => ({ chatId: c.chatId, userId, role: "member" as const })))
        .onConflictDoNothing();
    }
    await this.notify(spaceId);
    return true;
  },

  /** Join a Space directly by id (used when you already hold the exact id). */
  async join(spaceId: string, userId: string): Promise<SpaceDetail> {
    const [space] = await getDb().select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    if (!space) throw AppError.notFound("Space not found.");
    await this.addMember(spaceId, userId);
    return this.getDetail(spaceId, userId);
  },

  /**
   * Resolve a user-supplied join target — an invite code, an @handle, or an id.
   * Invite codes work for any Space (including private); handle/id joins are
   * allowed only for public Spaces.
   */
  async resolveJoin(target: string, userId: string): Promise<SpaceDetail> {
    const db = getDb();
    const raw = target.trim();

    // 1) Invite code (case-sensitive, exact).
    const [invite] = await db.select().from(spaceInvites).where(eq(spaceInvites.code, raw)).limit(1);
    if (invite) return this.redeemInvite(invite.code, userId);

    // 2) @handle or id — public Spaces only.
    const key = raw.replace(/^@/, "").toLowerCase();
    const byId = /^[0-9a-f-]{36}$/i.test(raw)
      ? (await db.select().from(spaces).where(eq(spaces.id, raw)).limit(1))[0]
      : undefined;
    const space =
      byId ??
      (await db.select().from(spaces).where(eq(spaces.handle, key)).limit(1))[0];
    if (!space) throw AppError.notFound("No Space found for that code or handle.");
    if (space.visibility !== "public") {
      throw AppError.forbidden("This Space is invite-only — ask for an invite link.");
    }
    await this.addMember(space.id, userId);
    return this.getDetail(space.id, userId);
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

  /* -- Invites ----------------------------------------------------------- */

  /** Create a shareable invite (any member may invite). */
  async createInvite(
    spaceId: string,
    userId: string,
    input: { maxUses?: number; expiresInHours?: number }
  ): Promise<PublicSpaceInvite> {
    await this.assertMember(spaceId, userId);
    const db = getDb();
    // A short unique code.
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const [clash] = await db.select({ id: spaceInvites.id }).from(spaceInvites).where(eq(spaceInvites.code, code)).limit(1);
      if (!clash) break;
      code = genCode();
    }
    const expiresAt =
      input.expiresInHours && input.expiresInHours > 0
        ? new Date(Date.now() + input.expiresInHours * 3600 * 1000)
        : null;
    const [invite] = await db
      .insert(spaceInvites)
      .values({
        spaceId,
        code,
        createdBy: userId,
        maxUses: input.maxUses ?? null,
        expiresAt,
      })
      .returning();
    return toPublicSpaceInvite(invite!);
  },

  /** List a Space's non-revoked invites (needs manage_members). */
  async listInvites(spaceId: string, userId: string): Promise<PublicSpaceInvite[]> {
    await this.assertCan(spaceId, userId, "manage_members");
    const rows = await getDb()
      .select()
      .from(spaceInvites)
      .where(and(eq(spaceInvites.spaceId, spaceId), isNull(spaceInvites.revokedAt)))
      .orderBy(desc(spaceInvites.createdAt));
    return rows.map(toPublicSpaceInvite);
  },

  /** Revoke an invite (the creator, or anyone with manage_members). */
  async revokeInvite(inviteId: string, userId: string): Promise<void> {
    const db = getDb();
    const [invite] = await db.select().from(spaceInvites).where(eq(spaceInvites.id, inviteId)).limit(1);
    if (!invite) throw AppError.notFound("Invite not found.");
    if (invite.createdBy !== userId) {
      await this.assertCan(invite.spaceId, userId, "manage_members");
    } else {
      await this.assertMember(invite.spaceId, userId);
    }
    await db.update(spaceInvites).set({ revokedAt: new Date() }).where(eq(spaceInvites.id, inviteId));
  },

  /** Redeem an invite code and join the Space (works for private Spaces). */
  async redeemInvite(code: string, userId: string): Promise<SpaceDetail> {
    const db = getDb();
    const [invite] = await db.select().from(spaceInvites).where(eq(spaceInvites.code, code)).limit(1);
    if (!invite) throw AppError.notFound("That invite is invalid.");
    if (invite.revokedAt) throw AppError.validation("That invite has been revoked.");
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw AppError.validation("That invite has expired.");
    }
    if (invite.maxUses != null && invite.uses >= invite.maxUses) {
      throw AppError.validation("That invite has reached its use limit.");
    }
    const added = await this.addMember(invite.spaceId, userId);
    if (added) {
      await db
        .update(spaceInvites)
        .set({ uses: invite.uses + 1 })
        .where(eq(spaceInvites.id, invite.id));
    }
    return this.getDetail(invite.spaceId, userId);
  },

  /* -- Events ------------------------------------------------------------ */

  /** Turn event rows into DTOs with RSVP counts + the viewer's RSVP + join chat. */
  async hydrateEvents(rows: SpaceEvent[], viewerId: string): Promise<PublicSpaceEvent[]> {
    if (rows.length === 0) return [];
    const db = getDb();
    const ids = rows.map((r) => r.id);
    const rsvps = await db.select().from(spaceEventRsvps).where(inArray(spaceEventRsvps.eventId, ids));

    const going = new Map<string, number>();
    const interested = new Map<string, number>();
    const mine = new Map<string, "going" | "interested">();
    for (const r of rsvps) {
      if (r.status === "going") going.set(r.eventId, (going.get(r.eventId) ?? 0) + 1);
      else if (r.status === "interested") {
        interested.set(r.eventId, (interested.get(r.eventId) ?? 0) + 1);
      }
      if (r.userId === viewerId) mine.set(r.eventId, r.status as "going" | "interested");
    }

    // Resolve linked channels → their backing chat id (for "join call").
    const channelIds = [...new Set(rows.map((r) => r.channelId).filter((c): c is string => !!c))];
    const chanRows = channelIds.length
      ? await db.select().from(spaceChannels).where(inArray(spaceChannels.id, channelIds))
      : [];
    const chatByChannel = new Map(chanRows.map((c) => [c.id, c.chatId]));

    const now = Date.now();
    return rows.map((e) =>
      toPublicSpaceEvent(e, {
        going: going.get(e.id) ?? 0,
        interested: interested.get(e.id) ?? 0,
        myRsvp: mine.get(e.id) ?? null,
        callChatId: e.channelId ? chatByChannel.get(e.channelId) ?? null : null,
        now,
      })
    );
  },

  /** Upcoming + still-live events for a Space (canceled hidden; live linger 6h). */
  async eventsForSpace(spaceId: string, viewerId: string): Promise<PublicSpaceEvent[]> {
    const cutoff = new Date(Date.now() - 6 * 3600 * 1000);
    const rows = await getDb()
      .select()
      .from(spaceEvents)
      .where(
        and(
          eq(spaceEvents.spaceId, spaceId),
          isNull(spaceEvents.canceledAt),
          gte(spaceEvents.startsAt, cutoff)
        )
      )
      .orderBy(spaceEvents.startsAt);
    return this.hydrateEvents(rows, viewerId);
  },

  async listEvents(spaceId: string, userId: string): Promise<PublicSpaceEvent[]> {
    await this.assertMember(spaceId, userId);
    return this.eventsForSpace(spaceId, userId);
  },

  /** Create an event and notify every member. Any member may create one. */
  async createEvent(
    spaceId: string,
    userId: string,
    input: { title: string; description?: string; startsAt: Date; channelId?: string }
  ): Promise<PublicSpaceEvent[]> {
    await this.assertMember(spaceId, userId);
    const db = getDb();

    // A linked channel must belong to this Space.
    if (input.channelId) {
      const [chan] = await db
        .select({ id: spaceChannels.id })
        .from(spaceChannels)
        .where(and(eq(spaceChannels.id, input.channelId), eq(spaceChannels.spaceId, spaceId)))
        .limit(1);
      if (!chan) throw AppError.validation("That channel isn’t in this Space.");
    }

    const [event] = await db
      .insert(spaceEvents)
      .values({
        spaceId,
        createdBy: userId,
        title: input.title,
        description: input.description ?? null,
        startsAt: input.startsAt,
        channelId: input.channelId ?? null,
      })
      .returning();

    // Notify everyone else in the Space.
    const memberIds = await this.memberIds(spaceId);
    await Promise.all(
      memberIds
        .filter((id) => id !== userId)
        .map((id) =>
          notificationService.create(id, {
            type: "space_event",
            data: { spaceId, eventId: event!.id, title: event!.title },
          })
        )
    );
    await this.notify(spaceId);
    return this.eventsForSpace(spaceId, userId);
  },

  /** Cancel an event (creator, or anyone with manage_members). */
  async cancelEvent(eventId: string, userId: string): Promise<void> {
    const db = getDb();
    const [event] = await db.select().from(spaceEvents).where(eq(spaceEvents.id, eventId)).limit(1);
    if (!event) throw AppError.notFound("Event not found.");
    if (event.createdBy !== userId) {
      await this.assertCan(event.spaceId, userId, "manage_members");
    } else {
      await this.assertMember(event.spaceId, userId);
    }
    await db.update(spaceEvents).set({ canceledAt: new Date() }).where(eq(spaceEvents.id, eventId));
    await this.notify(event.spaceId);
  },

  /** RSVP to an event: "going" | "interested" | "none" (removes the RSVP). */
  async rsvp(
    eventId: string,
    userId: string,
    status: "going" | "interested" | "none"
  ): Promise<PublicSpaceEvent[]> {
    const db = getDb();
    const [event] = await db.select().from(spaceEvents).where(eq(spaceEvents.id, eventId)).limit(1);
    if (!event) throw AppError.notFound("Event not found.");
    await this.assertMember(event.spaceId, userId);

    await db
      .delete(spaceEventRsvps)
      .where(and(eq(spaceEventRsvps.eventId, eventId), eq(spaceEventRsvps.userId, userId)));
    if (status !== "none") {
      await db.insert(spaceEventRsvps).values({ eventId, userId, status });
    }
    await this.notify(event.spaceId);
    return this.eventsForSpace(event.spaceId, userId);
  },

  /**
   * Scheduler hook: notify RSVP'd users of events that have just gone live.
   * Returns how many events were fired (for logging).
   */
  async notifyDueEvents(): Promise<number> {
    const db = getDb();
    const now = new Date();
    const due = await db
      .select()
      .from(spaceEvents)
      .where(
        and(
          isNull(spaceEvents.canceledAt),
          isNull(spaceEvents.notifiedAt),
          lte(spaceEvents.startsAt, now)
        )
      );
    for (const event of due) {
      // Claim it first so a concurrent tick doesn't double-notify.
      const claimed = await db
        .update(spaceEvents)
        .set({ notifiedAt: now })
        .where(and(eq(spaceEvents.id, event.id), isNull(spaceEvents.notifiedAt)))
        .returning();
      if (claimed.length === 0) continue;

      const rsvps = await db
        .select({ userId: spaceEventRsvps.userId })
        .from(spaceEventRsvps)
        .where(eq(spaceEventRsvps.eventId, event.id));
      await Promise.all(
        rsvps.map((r) =>
          notificationService.create(r.userId, {
            type: "space_event_live",
            data: { spaceId: event.spaceId, eventId: event.id, title: event.title },
          })
        )
      );
      hub.broadcastToUsers(await this.memberIds(event.spaceId), {
        type: "space.updated",
        spaceId: event.spaceId,
      });
    }
    return due.length;
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
      events: await this.eventsForSpace(spaceId, userId),
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
