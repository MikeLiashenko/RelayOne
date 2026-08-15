import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveSession } from "../auth/sessions";
import { chatService } from "../services/chatService";
import { userService } from "../services/userService";
import { handleCallDisconnect, handleCallEvent } from "./calls";
import type { ClientEvent, ServerEvent } from "./events";
import { hub } from "./hub";

/**
 * WebSocket gateway. Authenticates the connection with a bearer token, tracks
 * presence, and handles inbound typing/read events. Outbound message/reaction
 * events are pushed by the services via the hub. Kept separate from the REST
 * app so it can scale/evolve independently (and host Calls signaling later).
 */
export function attachRealtime(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (socket: WebSocket, req: IncomingMessage) => {
    const token = extractToken(req);
    const resolved = token ? await resolveSession(token) : null;
    if (!resolved) {
      socket.close(4401, "unauthorized");
      return;
    }

    const userId = resolved.user.id;
    const wasOnline = hub.isOnline(userId);
    hub.add(userId, socket);
    if (!wasOnline) await broadcastPresence(userId, true);

    send(socket, { type: "ready", userId });

    socket.on("message", (data) => {
      void handleClientEvent(userId, socket, data.toString());
    });

    socket.on("close", async () => {
      hub.remove(userId, socket);
      handleCallDisconnect(userId);
      if (!hub.isOnline(userId)) await broadcastPresence(userId, false);
    });

    socket.on("error", () => {
      hub.remove(userId, socket);
    });
  });

  return wss;
}

async function handleClientEvent(
  userId: string,
  socket: WebSocket,
  raw: string
): Promise<void> {
  let event: ClientEvent;
  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    return; // ignore malformed frames
  }

  switch (event?.type) {
    case "ping":
      send(socket, { type: "pong" });
      return;

    case "typing": {
      // Only members may signal typing, and only members receive it.
      if (!(await chatService.isMember(event.chatId, userId))) return;
      const members = await chatService.getMemberIds(event.chatId);
      hub.broadcastToUsers(
        members,
        {
          type: "typing",
          chatId: event.chatId,
          userId,
          isTyping: Boolean(event.isTyping),
        },
        userId
      );
      return;
    }

    case "read": {
      if (!(await chatService.isMember(event.chatId, userId))) return;
      await chatService.markRead(event.chatId, userId, event.messageId);
      const members = await chatService.getMemberIds(event.chatId);
      hub.broadcastToUsers(members, {
        type: "read",
        chatId: event.chatId,
        userId,
        lastReadMessageId: event.messageId,
        at: new Date().toISOString(),
      });
      return;
    }

    case "call.invite":
    case "call.accept":
    case "call.decline":
    case "call.cancel":
    case "call.busy":
    case "call.end":
    case "call.signal":
    case "call.group-start":
    case "call.group-join":
    case "call.group-leave":
      await handleCallEvent(userId, event);
      return;

    default:
      // Unknown event types are ignored — forward-compatible with future work.
      return;
  }
}

async function broadcastPresence(userId: string, online: boolean): Promise<void> {
  // Best-effort: a DB hiccup (or shutdown) during connect/disconnect must not
  // crash the gateway or surface as an unhandled rejection.
  try {
    // Reciprocal last-seen privacy: a user who hides their status isn't
    // announced, and users who hide theirs don't receive others' presence.
    const selfHidden = await userService.lastSeenHiddenSet([userId]);
    if (selfHidden.has(userId)) return;
    const peers = await chatService.getPeerUserIds(userId);
    if (peers.length === 0) return;
    const peerHidden = await userService.lastSeenHiddenSet(peers);
    const audience = peers.filter((p) => !peerHidden.has(p));
    hub.broadcastToUsers(audience, { type: "presence", userId, online });
  } catch {
    /* ignore */
  }
}

function extractToken(req: IncomingMessage): string | null {
  // Prefer the Sec-WebSocket-Protocol header (`bearer, <token>`), fall back to
  // a `?token=` query param for simple browser clients.
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string" && proto.includes(",")) {
    const parts = proto.split(",").map((p) => p.trim());
    if (parts[0]?.toLowerCase() === "bearer" && parts[1]) return parts[1];
  }
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
