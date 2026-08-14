import { chatService } from "../services/chatService";
import type { CallClientEvent } from "./events";
import { hub } from "./hub";

/**
 * RelayOne Calls — signaling relay.
 *
 * The server stays deliberately dumb about media: it authorizes participants
 * and forwards opaque WebRTC signaling between them. A small in-memory session
 * registry keeps authorization cheap (no DB hit per ICE candidate) and models
 * a call as a *set* of participants, so group calls can grow from this later.
 *
 * Sessions live only for the duration of a call and are cleaned up on
 * decline/cancel/end and on participant disconnect.
 */

interface CallSession {
  callId: string;
  chatId: string;
  participants: Set<string>;
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
      return relay(userId, event.callId, {
        type: "call.signal",
        signal: event.signal,
      });
  }
}

/** Tear down any calls a disconnecting user was part of, notifying the peer. */
export function handleCallDisconnect(userId: string): void {
  for (const [callId, session] of sessions) {
    if (!session.participants.has(userId)) continue;
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
  });

  hub.sendToUser(toUserId, {
    type: "call.invite",
    callId,
    chatId,
    fromUserId: userId,
    media,
  });
}

/** Forward an event to the other participant(s). Sender must be in the call. */
function relay(
  userId: string,
  callId: string,
  payload:
    | { type: "call.accept" }
    | { type: "call.signal"; signal: Extract<CallClientEvent, { type: "call.signal" }>["signal"] }
): void {
  const session = sessions.get(callId);
  if (!session || !session.participants.has(userId)) return;
  for (const peerId of session.participants) {
    if (peerId === userId) continue;
    if (payload.type === "call.signal") {
      hub.sendToUser(peerId, { type: "call.signal", callId, fromUserId: userId, signal: payload.signal });
    } else {
      hub.sendToUser(peerId, { type: "call.accept", callId, fromUserId: userId });
    }
  }
}

/** Relay a terminal event, then drop the session. */
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
