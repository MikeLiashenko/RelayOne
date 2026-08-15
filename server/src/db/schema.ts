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
    createdAt,
    updatedAt,
  },
  (t) => ({
    byType: index("chats_type_idx").on(t.type),
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
  },
  (t) => ({
    byChatTime: index("messages_chat_id_created_at_idx").on(
      t.chatId,
      t.createdAt
    ),
    bySender: index("messages_sender_id_idx").on(t.senderId),
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
