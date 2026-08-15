import type { PublicMessage, PublicNotification } from "../shared/types";

/**
 * Realtime event contracts. This layer is intentionally standalone so that
 * RelayOne Calls (voice/video signaling) can be added later as additional
 * event types without touching the messaging services.
 */

export type CallMedia = "audio" | "video";

/**
 * WebRTC signaling payload. Opaque to the server — it only relays it between
 * the two participants. Shaped loosely so SDP offers/answers and ICE
 * candidates all flow through the same channel (and stay forward-compatible
 * with group calls / renegotiation later).
 */
export type CallSignal = {
  kind: "offer" | "answer" | "candidate";
  description?: { type: string; sdp?: string };
  candidate?: unknown;
};

/* Server → client. */
export type ServerEvent =
  | { type: "ready"; userId: string }
  | { type: "pong" }
  | { type: "message.new"; message: PublicMessage }
  | { type: "message.edited"; message: PublicMessage }
  | { type: "message.deleted"; chatId: string; messageId: string }
  | {
      type: "message.pin";
      chatId: string;
      messageId: string;
      pinned: boolean;
      pinnedAt: string | null;
      by: string;
    }
  | {
      type: "message.reaction";
      chatId: string;
      messageId: string;
      emoji: string;
      userId: string;
      op: "add" | "remove";
    }
  | { type: "typing"; chatId: string; userId: string; isTyping: boolean }
  | { type: "presence"; userId: string; online: boolean }
  | {
      type: "read";
      chatId: string;
      userId: string;
      lastReadMessageId: string;
      at: string;
    }
  | { type: "notification"; notification: PublicNotification }
  /* -- Calls (voice/video signaling) -- */
  | { type: "call.invite"; callId: string; chatId: string; fromUserId: string; media: CallMedia }
  | { type: "call.accept"; callId: string; fromUserId: string }
  | { type: "call.decline"; callId: string; fromUserId: string }
  | { type: "call.cancel"; callId: string; fromUserId: string }
  | { type: "call.busy"; callId: string; fromUserId: string }
  | { type: "call.unavailable"; callId: string; fromUserId: string }
  | { type: "call.end"; callId: string; fromUserId: string; reason?: string }
  | { type: "call.signal"; callId: string; fromUserId: string; signal: CallSignal }
  /* -- Group calls (mesh) -- */
  | { type: "call.group-invite"; callId: string; chatId: string; fromUserId: string; media: CallMedia }
  | { type: "call.group-roster"; callId: string; chatId: string; media: CallMedia; peers: string[] }
  | { type: "call.group-peer-joined"; callId: string; userId: string }
  | { type: "call.group-peer-left"; callId: string; userId: string };

/* Client → server. */
export type ClientEvent =
  | { type: "ping" }
  | { type: "typing"; chatId: string; isTyping: boolean }
  | { type: "read"; chatId: string; messageId: string }
  /* -- Calls -- */
  | { type: "call.invite"; callId: string; chatId: string; toUserId: string; media: CallMedia }
  | { type: "call.accept"; callId: string; toUserId: string }
  | { type: "call.decline"; callId: string; toUserId: string }
  | { type: "call.cancel"; callId: string; toUserId: string }
  | { type: "call.busy"; callId: string; toUserId: string }
  | { type: "call.end"; callId: string; toUserId: string }
  | { type: "call.signal"; callId: string; toUserId: string; signal: CallSignal }
  /* -- Group calls (mesh) -- */
  | { type: "call.group-start"; callId: string; chatId: string; media: CallMedia }
  | { type: "call.group-join"; callId: string }
  | { type: "call.group-leave"; callId: string };

/** The subset of client events handled by the calls signaling module. */
export type CallClientEvent = Extract<ClientEvent, { type: `call.${string}` }>;
