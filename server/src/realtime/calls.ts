import { chatService } from "../services/chatService";
import type { CallClientEvent, CallMedia } from "./events";
import { hub } from "./hub";

/**
 * RelayOne Calls — signaling relay.
 *
 * The server stays deliberately dumb about media: it authorizes participants
 * and forwards opaque WebRTC signaling between them. A small in-memory session
 * registry keeps authorization cheap (no DB hit per ICE candidate) and models
 * a call as a *set* of participants.
 *
 * Two shapes share this registry:
 *   • 1:1 calls — invite → accept → signal, torn down on decline/cancel/end.
 *   • Group calls (mesh) — a starter opens a session and every online chat
 *     member is invited; each joiner connects to every existing participant
 *     (existing participants initiate the offer, so there's no glare). Signals
 *     are addressed to a specific peer via `toUserId`.
 *
 * Sessions live only for the duration of a call and are cleaned up on
 * decline/cancel/end, on the last participant leaving, and on disconnect.
 */

interface CallSession {
  callId: string;
  chatId: string;
  participants: Set<string>;
  group: boolean;
  media: CallMedia;
}

const sessions = new Map<string, CallSession>();

export function isCallEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("call.");
}

export async function handleCallEvent(
  userId: string,
  event: CallClientEvent
): Promise<void> {
  switch (event.type) {
    case "call.invite":
      return invite(userId, event);
    case "call.accept":
      return relay(userId, event.callId, { type: "call.accept" });
    case "call.decline":
      return relayAndClose(userId, event.callId, { type: "call.decline" });
    case "call.cancel":
      return relayAndClose(userId, event.callId, { type: "call.cancel" });
    case "call.busy":
      return relayAndClose(userId, event.callId, { type: "call.busy" });
    case "call.end":
      return relayAndClose(userId, event.callId, { type: "call.end" });
    case "call.signal":
      return signal(userId, event);
    /* -- Group calls -- */
    case "call.group-start":
      return groupStart(userId, event);
    case "call.group-join":
      return groupJoin(userId, event.callId);
    case "call.group-leave":
      return groupLeave(userId, event.callId);
  }
}

/** Tear down / update any calls a disconnecting user was part of. */
export function handleCallDisconnect(userId: string): void {
  for (const [callId, session] of sessions) {
    if (!session.participants.has(userId)) continue;

    if (session.group) {
      session.participants.delete(userId);
      for (const peerId of session.participants) {
        hub.sendToUser(peerId, { type: "call.group-peer-left", callId, userId });
      }
      if (session.participants.size === 0) sessions.delete(callId);
      continue;
    }

    for (const peerId of session.participants) {
      if (peerId === userId) continue;
      hub.sendToUser(peerId, {
        type: "call.end",
        callId,
        fromUserId: userId,
        reason: "disconnected",
      });
    }
    sessions.delete(callId);
  }
}

/* ========================================================================== */
/*  1:1 calls                                                                 */
/* ========================================================================== */

async function invite(
  userId: string,
  event: Extract<CallClientEvent, { type: "call.invite" }>
): Promise<void> {
  const { callId, chatId, toUserId, media } = event;
  if (toUserId === userId) return;

  // Both parties must belong to the chat the call is placed in.
  const [callerOk, calleeOk] = await Promise.all([
    chatService.isMember(chatId, userId),
    chatService.isMember(chatId, toUserId),
  ]);
  if (!callerOk || !calleeOk) return;

  if (!hub.isOnline(toUserId)) {
    hub.sendToUser(userId, { type: "call.unavailable", callId, fromUserId: toUserId });
    return;
  }

  sessions.set(callId, {
    callId,
    chatId,
    participants: new Set([userId, toUserId]),
    group: false,
    media,
  });

  hub.sendToUser(toUserId, {
    type: "call.invite",
    callId,
    chatId,
    fromUserId: userId,
    media,
  });
}

/** Forward accept to the other participant(s). Sender must be in the call. */
function relay(userId: string, callId: string, payload: { type: "call.accept" }): void {
  const session = sessions.get(callId);
  if (!session || !session.participants.has(userId)) return;
  for (const peerId of session.participants) {
    if (peerId === userId) continue;
    hub.sendToUser(peerId, { type: "call.accept", callId, fromUserId: userId });
  }
}

/**
 * Forward a signal. Addressed to a specific peer via `toUserId` (mesh group
 * calls send offers/answers/candidates per-peer); with no target it goes to the
 * other participant(s), which is the 1:1 case.
 */
function signal(
  userId: string,
  event: Extract<CallClientEvent, { type: "call.signal" }>
): void {
  const session = sessions.get(event.callId);
  if (!session || !session.participants.has(userId)) return;

  const deliver = (peerId: string) =>
    hub.sendToUser(peerId, {
      type: "call.signal",
      callId: event.callId,
      fromUserId: userId,
      signal: event.signal,
    });

  if (event.toUserId) {
    if (session.participants.has(event.toUserId)) deliver(event.toUserId);
    return;
  }
  for (const peerId of session.participants) {
    if (peerId !== userId) deliver(peerId);
  }
}

/** Relay a terminal 1:1 event, then drop the session. */
function relayAndClose(
  userId: string,
  callId: string,
  payload: { type: "call.decline" | "call.cancel" | "call.busy" | "call.end" }
): void {
  const session = sessions.get(callId);
  if (!session || !session.participants.has(userId)) return;
  for (const peerId of session.participants) {
    if (peerId === userId) continue;
    hub.sendToUser(peerId, { type: payload.type, callId, fromUserId: userId });
  }
  sessions.delete(callId);
}

/* ========================================================================== */
/*  Group calls (mesh)                                                        */
/* ========================================================================== */

async function groupStart(
  userId: string,
  event: Extract<CallClientEvent, { type: "call.group-start" }>
): Promise<void> {
  const { callId, chatId, media } = event;
  if (sessions.has(callId)) return;
  if (!(await chatService.isMember(chatId, userId))) return;

  sessions.set(callId, {
    callId,
    chatId,
    participants: new Set([userId]),
    group: true,
    media,
  });

  // Ring every other online member of the chat.
  const memberIds = await chatService.getMemberIds(chatId);
  for (const memberId of memberIds) {
    if (memberId === userId || !hub.isOnline(memberId)) continue;
    hub.sendToUser(memberId, {
      type: "call.group-invite",
      callId,
      chatId,
      fromUserId: userId,
      media,
    });
  }
}

async function groupJoin(userId: string, callId: string): Promise<void> {
  const session = sessions.get(callId);
  if (!session || !session.group) return;
  if (session.participants.has(userId)) return;
  if (!(await chatService.isMember(session.chatId, userId))) return;

  // The peers already in the call — the joiner will answer their offers.
  const existing = [...session.participants];

  // Tell the joiner who's already here (it awaits their offers).
  hub.sendToUser(userId, {
    type: "call.group-roster",
    callId,
    chatId: session.chatId,
    media: session.media,
    peers: existing,
  });

  // Tell each existing participant to initiate a connection to the joiner.
  for (const peerId of existing) {
    hub.sendToUser(peerId, { type: "call.group-peer-joined", callId, userId });
  }

  session.participants.add(userId);
}

function groupLeave(userId: string, callId: string): void {
  const session = sessions.get(callId);
  if (!session || !session.group || !session.participants.has(userId)) return;
  session.participants.delete(userId);
  for (const peerId of session.participants) {
    hub.sendToUser(peerId, { type: "call.group-peer-left", callId, userId });
  }
  if (session.participants.size === 0) sessions.delete(callId);
}
