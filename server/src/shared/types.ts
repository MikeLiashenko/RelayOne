/**
 * Public DTOs — the shapes returned to clients. These are deliberately NOT the
 * raw database rows: token hashes, salts and other internals never appear here.
 */

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
}

export interface PrivacySettings {
  messages: "everyone" | "contacts" | "nobody";
  lastSeen: "everyone" | "nobody";
  avatar: "everyone" | "contacts" | "nobody";
}

/** The authenticated user's own view — includes contact fields + privacy. */
export interface SelfUser extends PublicUser {
  email: string | null;
  phone: string | null;
  updatedAt: string;
  privacy: PrivacySettings;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  user: SelfUser;
}

export interface PublicChat {
  id: string;
  type: "direct" | "group" | "channel" | "saved";
  title: string | null;
  createdAt: string;
  updatedAt: string;
  members: PublicUser[];
}

/** Per-member read + presence state, exposed on chat detail. */
export interface ChatMemberState {
  userId: string;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
  online: boolean;
}

export interface ChatDetail extends PublicChat {
  memberStates: ChatMemberState[];
}

export interface ChatLastMessage {
  id: string;
  senderId: string;
  content: string | null;
  createdAt: string;
  deletedAt: string | null;
}

/** Chat-list row: enough to render the list without opening the chat. */
export interface ChatSummary extends PublicChat {
  lastMessage: ChatLastMessage | null;
  unreadCount: number;
  online: boolean;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  content: string | null;
}

export interface PublicPollOption {
  id: string;
  text: string;
  votes: number;
  /** Quiz only, revealed once the viewer has voted or the poll is closed. */
  correct?: boolean;
  /** Non-anonymous polls only: who picked this option. */
  voters?: string[];
}

export interface PublicPoll {
  id: string;
  question: string;
  allowsMultiple: boolean;
  anonymous: boolean;
  isQuiz: boolean;
  closed: boolean;
  totalVoters: number;
  options: PublicPollOption[];
  /** Option ids the viewer voted for. */
  myVotes: string[];
}

export interface PublicMessage {
  id: string;
  chatId: string;
  senderId: string;
  content: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  pinnedBy: string | null;
  expiresAt: string | null;
  replyTo: ReplyPreview | null;
  replyCount: number;
  poll: PublicPoll | null;
  attachments: PublicAttachment[];
  reactions: PublicReaction[];
}

export interface PublicAttachment {
  id: string;
  kind: "image" | "video" | "document" | "voice";
  url: string;
  mimeType: string;
  sizeBytes: number;
  fileName: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

export interface PublicReaction {
  emoji: string;
  userId: string;
}

export interface PublicNotification {
  id: string;
  type: string;
  chatId: string | null;
  messageId: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}
