import type { WebSocket } from "ws";
import type { ServerEvent } from "./events";

/**
 * Connection registry + fan-out. Holds the live sockets per user and knows
 * nothing about chats or the database — callers pass the target user ids. This
 * keeps the transport decoupled from domain logic and easy to test/replace
 * (e.g. swap the in-memory map for Redis pub/sub across instances later).
 */
class RealtimeHub {
  private byUser = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket): void {
    const set = this.byUser.get(userId) ?? new Set<WebSocket>();
    set.add(socket);
    this.byUser.set(userId, set);
  }

  remove(userId: string, socket: WebSocket): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byUser.delete(userId);
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  sendToUser(userId: string, event: ServerEvent): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  broadcastToUsers(
    userIds: Iterable<string>,
    event: ServerEvent,
    exceptUserId?: string
  ): void {
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (userId === exceptUserId || seen.has(userId)) continue;
      seen.add(userId);
      this.sendToUser(userId, event);
    }
  }
}

export const hub = new RealtimeHub();
