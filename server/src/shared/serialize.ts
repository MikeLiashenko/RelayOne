import type {
  Attachment,
  Chat,
  Message,
  MessageReaction,
  Notification,
  User,
} from "../db/schema";
import { env } from "../config/env";
import type {
  PublicAttachment,
  PublicChat,
  PublicMessage,
  PublicNotification,
  PublicReaction,
  PublicUser,
  SelfUser,
} from "./types";

/**
 * Row → DTO mappers. The client only ever sees these shapes, so secrets and
 * storage internals stay server-side.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toSelfUser(u: User): SelfUser {
  return {
    ...toPublicUser(u),
    email: u.email,
    phone: u.phone,
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function toPublicChat(chat: Chat, members: User[]): PublicChat {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    members: members.map(toPublicUser),
  };
}

export function toPublicAttachment(a: Attachment): PublicAttachment {
  return {
    id: a.id,
    kind: a.kind,
    url: `${env.STORAGE_PUBLIC_BASE_URL}/${a.storageKey}`,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    fileName: a.fileName,
    width: a.width,
    height: a.height,
    durationSeconds: a.durationSeconds,
  };
}

export function toPublicReaction(r: MessageReaction): PublicReaction {
  return { emoji: r.emoji, userId: r.userId };
}

export function toPublicMessage(
  m: Message,
  attachments: Attachment[] = [],
  reactions: MessageReaction[] = [],
  replyTo: Message | null = null
): PublicMessage {
  return {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    // Deleted messages are tombstoned: content is withheld, metadata remains.
    content: m.deletedAt ? null : m.content,
    createdAt: m.createdAt.toISOString(),
    editedAt: iso(m.editedAt),
    deletedAt: iso(m.deletedAt),
    pinnedAt: iso(m.pinnedAt),
    pinnedBy: m.pinnedBy ?? null,
    replyTo: replyTo
      ? {
          id: replyTo.id,
          senderId: replyTo.senderId,
          content: replyTo.deletedAt ? null : replyTo.content,
        }
      : null,
    attachments: m.deletedAt ? [] : attachments.map(toPublicAttachment),
    reactions: reactions.map(toPublicReaction),
  };
}

export function toPublicNotification(n: Notification): PublicNotification {
  return {
    id: n.id,
    type: n.type,
    chatId: n.chatId,
    messageId: n.messageId,
    data: n.data ?? null,
    readAt: iso(n.readAt),
    createdAt: n.createdAt.toISOString(),
  };
}
