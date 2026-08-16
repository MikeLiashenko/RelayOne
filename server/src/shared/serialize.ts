import type {
  Attachment,
  Chat,
  Message,
  MessageReaction,
  Notification,
  Poll,
  PollOption,
  PollVote,
  Space,
  SpaceChannel,
  User,
} from "../db/schema";
import { env } from "../config/env";
import type {
  PublicAttachment,
  PublicChat,
  PublicMessage,
  PublicNotification,
  PublicPoll,
  PublicReaction,
  PublicSpace,
  PublicSpaceChannel,
  PublicUser,
  SelfUser,
  SpaceRole,
} from "./types";

/**
 * Row → DTO mappers. The client only ever sees these shapes, so secrets and
 * storage internals stay server-side.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toPublicUser(u: User, opts?: { hideAvatar?: boolean }): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: opts?.hideAvatar ? null : u.avatarUrl,
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
    privacy: {
      messages: (u.privacyMessages as SelfUser["privacy"]["messages"]) ?? "everyone",
      lastSeen: (u.privacyLastSeen as SelfUser["privacy"]["lastSeen"]) ?? "everyone",
      avatar: (u.privacyAvatar as SelfUser["privacy"]["avatar"]) ?? "everyone",
    },
  };
}

/**
 * Whether `viewerId` may see `owner`'s avatar. Within a shared chat everyone is
 * a "contact", so pass `isContact` accordingly (true for chat member lists).
 */
export function canSeeAvatar(owner: User, viewerId: string | undefined, isContact: boolean): boolean {
  if (owner.id === viewerId) return true;
  const p = owner.privacyAvatar ?? "everyone";
  if (p === "nobody") return false;
  if (p === "contacts") return isContact;
  return true;
}

/**
 * Serialize a poll for a specific viewer. Vote counts are always public; who
 * voted is revealed only for non-anonymous polls; the quiz answer is revealed
 * only once the viewer has voted or the poll is closed.
 */
export function toPublicPoll(
  poll: Poll,
  options: PollOption[],
  votes: PollVote[],
  viewerId?: string
): PublicPoll {
  const opts = options
    .filter((o) => o.pollId === poll.id)
    .sort((a, b) => a.position - b.position);
  const pollVotesList = votes.filter((v) => v.pollId === poll.id);

  const votersByOption = new Map<string, string[]>();
  for (const v of pollVotesList) {
    const arr = votersByOption.get(v.optionId) ?? [];
    arr.push(v.userId);
    votersByOption.set(v.optionId, arr);
  }
  const voterSet = new Set(pollVotesList.map((v) => v.userId));
  const myVotes = pollVotesList.filter((v) => v.userId === viewerId).map((v) => v.optionId);
  const closed = poll.closedAt != null;
  const revealQuiz = poll.isQuiz && (myVotes.length > 0 || closed);

  return {
    id: poll.id,
    question: poll.question,
    allowsMultiple: poll.allowsMultiple,
    anonymous: poll.anonymous,
    isQuiz: poll.isQuiz,
    closed,
    totalVoters: voterSet.size,
    myVotes,
    options: opts.map((o) => ({
      id: o.id,
      text: o.text,
      votes: votersByOption.get(o.id)?.length ?? 0,
      ...(revealQuiz ? { correct: o.id === poll.correctOptionId } : {}),
      ...(poll.anonymous ? {} : { voters: votersByOption.get(o.id) ?? [] }),
    })),
  };
}

export function toPublicChat(chat: Chat, members: User[], viewerId?: string): PublicChat {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    // Chat members share this chat, so they're contacts of each other — only a
    // strict "nobody" avatar policy hides a member's photo (never from self).
    members: members.map((m) =>
      toPublicUser(m, { hideAvatar: !canSeeAvatar(m, viewerId, true) })
    ),
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
  replyTo: Message | null = null,
  replyCount = 0
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
    expiresAt: iso(m.expiresAt),
    replyTo: replyTo
      ? {
          id: replyTo.id,
          senderId: replyTo.senderId,
          content: replyTo.deletedAt ? null : replyTo.content,
        }
      : null,
    replyCount,
    poll: null,
    attachments: m.deletedAt ? [] : attachments.map(toPublicAttachment),
    reactions: reactions.map(toPublicReaction),
  };
}

export function toPublicSpaceChannel(c: SpaceChannel): PublicSpaceChannel {
  return {
    id: c.id,
    chatId: c.chatId,
    name: c.name,
    icon: c.icon,
    kind: c.kind,
    position: c.position,
  };
}

export function toPublicSpace(
  space: Space,
  opts: { memberCount: number; myRole: SpaceRole | null }
): PublicSpace {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    avatarUrl: space.avatarUrl,
    memberCount: opts.memberCount,
    myRole: opts.myRole,
    createdAt: space.createdAt.toISOString(),
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
