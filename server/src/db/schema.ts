import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/* ==========================================================================
   Enums
   ========================================================================== */

export const channelEnum = pgEnum("channel", ["email", "phone"]);
export const verificationPurposeEnum = pgEnum("verification_purpose", [
  "register",
  "login",
]);
export const chatTypeEnum = pgEnum("chat_type", ["direct", "group", "channel", "saved"]);
export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "member"]);
export const spaceRoleEnum = pgEnum("space_role", [
  "owner",
  "admin",
  "moderator",
  "member",
]);
export const spaceChannelKindEnum = pgEnum("space_channel_kind", [
  "text",
  "announcement",
  "voice",
]);
export const attachmentKindEnum = pgEnum("attachment_kind", [
  "image",
  "video",
  "document",
  "voice",
]);

/* Reusable timestamp columns. */
const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

/* ==========================================================================
   users
   ========================================================================== */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    avatarUrl: text("avatar_url"),
    bio: text("bio"),
    // Privacy. messages/avatar ∈ everyone|contacts|nobody; lastSeen ∈ everyone|nobody.
    // "contacts" = users you share a chat or group with.
    privacyMessages: text("privacy_messages").notNull().default("everyone"),
    privacyLastSeen: text("privacy_last_seen").notNull().default("everyone"),
    privacyAvatar: text("privacy_avatar").notNull().default("everyone"),
    createdAt,
    updatedAt,
  },
  (t) => ({
    // Case-insensitive unique username.
    usernameUnique: uniqueIndex("users_username_lower_unique").on(
      sql`lower(${t.username})`
    ),
    // Nullable identifiers are unique only when present.
    emailUnique: uniqueIndex("users_email_unique")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    phoneUnique: uniqueIndex("users_phone_unique")
      .on(t.phone)
      .where(sql`${t.phone} is not null`),
  })
);

/* ==========================================================================
   devices — one row per client sign-in surface (multi-device per account)
   ========================================================================== */

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name"),
    platform: text("platform"),
    pushToken: text("push_token"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => ({
    byUser: index("devices_user_id_idx").on(t.userId),
  })
);

/* ==========================================================================
   sessions — opaque bearer tokens, stored hashed, revocable per device
   ========================================================================== */

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    createdAt,
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenUnique: uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    byUser: index("sessions_user_id_idx").on(t.userId),
    byExpiry: index("sessions_expires_at_idx").on(t.expiresAt),
  })
);

/* ==========================================================================
   verification_codes — hashed one-time codes for register/login
   ========================================================================== */

export const verificationCodes = pgTable(
  "verification_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    channel: channelEnum("channel").notNull(),
    purpose: verificationPurposeEnum("purpose").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    codeSalt: text("code_salt").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt,
  },
  (t) => ({
    byIdentifier: index("verification_codes_identifier_idx").on(t.identifier),
    byExpiry: index("verification_codes_expires_at_idx").on(t.expiresAt),
  })
);

/* ==========================================================================
   chats — direct (1:1) and group, one model
   ========================================================================== */

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: chatTypeEnum("type").notNull(),
    title: text("title"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // When set, this chat is a channel inside a Space (excluded from the normal
    // chat list; browsed through the Space view instead).
    spaceId: uuid("space_id").references((): AnyPgColumn => spaces.id, {
      onDelete: "cascade",
    }),
    createdAt,
    updatedAt,
  },
  (t) => ({
    byType: index("chats_type_idx").on(t.type),
    bySpace: index("chats_space_id_idx").on(t.spaceId),
  })
);

/* ==========================================================================
   chat_members
   ========================================================================== */

export const chatMembers = pgTable(
  "chat_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("member"),
    lastReadMessageId: uuid("last_read_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    muted: boolean("muted").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    memberUnique: uniqueIndex("chat_members_chat_user_unique").on(
      t.chatId,
      t.userId
    ),
    byUser: index("chat_members_user_id_idx").on(t.userId),
  })
);

/* ==========================================================================
   messages
   ========================================================================== */

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content"),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    createdAt,
    updatedAt,
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: uuid("pinned_by").references(() => users.id, { onDelete: "set null" }),
    // Self-destruct: the message is swept (soft-deleted) once this passes.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    byChatTime: index("messages_chat_id_created_at_idx").on(
      t.chatId,
      t.createdAt
    ),
    bySender: index("messages_sender_id_idx").on(t.senderId),
    byExpiry: index("messages_expires_at_idx").on(t.expiresAt),
  })
);

/* ==========================================================================
   message_reactions
   ========================================================================== */

export const messageReactions = pgTable(
  "message_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt,
  },
  (t) => ({
    reactionUnique: uniqueIndex("message_reactions_unique").on(
      t.messageId,
      t.userId,
      t.emoji
    ),
    byMessage: index("message_reactions_message_id_idx").on(t.messageId),
  })
);

/* ==========================================================================
   attachments — metadata only; bytes live in object storage
   ========================================================================== */

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: attachmentKindEnum("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    fileName: text("file_name"),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    createdAt,
  },
  (t) => ({
    byMessage: index("attachments_message_id_idx").on(t.messageId),
    byUploader: index("attachments_uploader_id_idx").on(t.uploaderId),
  })
);

/* ==========================================================================
   storage_objects — durable object bytes (avatars, attachments)

   The `db` storage provider keeps file bytes here instead of the local disk,
   which is ephemeral on hosts like Render's free tier. Bytes are stored as
   base64 text for portability across the postgres.js and PGlite drivers.
   Fine for small files (avatars); large media would be better on real object
   storage (S3/R2), which the StorageProvider interface already allows.
   ========================================================================== */

export const storageObjects = pgTable("storage_objects", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull(),
  data: text("data").notNull(), // base64-encoded bytes
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt,
});

/* ==========================================================================
   push_subscriptions — Web Push (VAPID) endpoints per device

   Lets RelayOne deliver notifications when the tab/app is closed. One row per
   browser push subscription; `endpoint` is globally unique (re-subscribing
   just moves it to the current user). Stale endpoints are pruned on 404/410.
   ========================================================================== */

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt,
  },
  (t) => ({
    byUser: index("push_subscriptions_user_id_idx").on(t.userId),
  })
);

/* ==========================================================================
   scheduled_messages — messages queued to send at a future time
   ========================================================================== */

export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content"),
    replyToId: uuid("reply_to_id"),
    // Optional self-destruct applied once the scheduled message is sent.
    ttlSeconds: integer("ttl_seconds"),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdAt,
  },
  (t) => ({
    byDue: index("scheduled_messages_send_at_idx").on(t.sendAt),
    bySender: index("scheduled_messages_sender_idx").on(t.senderId),
  })
);

/* ==========================================================================
   polls — a poll attached to a message (+ options + votes)
   ========================================================================== */

export const polls = pgTable("polls", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .unique()
    .references(() => messages.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  allowsMultiple: boolean("allows_multiple").notNull().default(false),
  anonymous: boolean("anonymous").notNull().default(false),
  isQuiz: boolean("is_quiz").notNull().default(false),
  correctOptionId: uuid("correct_option_id"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt,
});

export const pollOptions = pgTable(
  "poll_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => ({ byPoll: index("poll_options_poll_id_idx").on(t.pollId) })
);

export const pollVotes = pgTable(
  "poll_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pollId: uuid("poll_id")
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    optionId: uuid("option_id")
      .notNull()
      .references(() => pollOptions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => ({
    byPoll: index("poll_votes_poll_id_idx").on(t.pollId),
    // One row per (poll, user, option) — prevents double-voting the same option.
    uniqueVote: uniqueIndex("poll_votes_unique").on(t.pollId, t.userId, t.optionId),
  })
);

/* ==========================================================================
   message_edits — prior versions of an edited message (edit history)
   ========================================================================== */

export const messageEdits = pgTable(
  "message_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    content: text("content"),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMessage: index("message_edits_message_id_idx").on(t.messageId),
  })
);

/* ==========================================================================
   spaces — communities (Discord-like) with nested channels and roles

   A Space groups people around channels. Each channel is backed by a normal
   `chats` row (so messages, reactions, threads, polls and shared media all work
   unchanged); `space_channels` adds the channel's Space metadata (icon, kind,
   ordering). Membership + roles live in `space_members`; joining a Space adds
   the user to every channel chat, so the existing per-chat authorization and
   realtime fan-out keep working with no changes.
   ========================================================================== */

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt,
    updatedAt,
  },
  (t) => ({
    byCreator: index("spaces_created_by_idx").on(t.createdBy),
  })
);

export const spaceMembers = pgTable(
  "space_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: spaceRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    memberUnique: uniqueIndex("space_members_space_user_unique").on(
      t.spaceId,
      t.userId
    ),
    byUser: index("space_members_user_id_idx").on(t.userId),
  })
);

export const spaceChannels = pgTable(
  "space_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    // The backing chat that actually holds this channel's messages.
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    kind: spaceChannelKindEnum("kind").notNull().default("text"),
    position: integer("position").notNull().default(0),
    createdAt,
  },
  (t) => ({
    bySpace: index("space_channels_space_id_idx").on(t.spaceId),
    chatUnique: uniqueIndex("space_channels_chat_id_unique").on(t.chatId),
  })
);

/* ==========================================================================
   notifications
   ========================================================================== */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    data: jsonb("data").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt,
  },
  (t) => ({
    byUserTime: index("notifications_user_id_created_at_idx").on(
      t.userId,
      t.createdAt
    ),
    unreadByUser: index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  })
);

/* ==========================================================================
   Inferred types
   ========================================================================== */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type ChatMember = typeof chatMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageReaction = typeof messageReactions.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Poll = typeof polls.$inferSelect;
export type PollOption = typeof pollOptions.$inferSelect;
export type PollVote = typeof pollVotes.$inferSelect;
export type ScheduledMessage = typeof scheduledMessages.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type SpaceMember = typeof spaceMembers.$inferSelect;
export type SpaceChannel = typeof spaceChannels.$inferSelect;
export type SpaceRole = (typeof spaceRoleEnum.enumValues)[number];
