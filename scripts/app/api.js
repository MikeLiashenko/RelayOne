/** REST client for the messaging endpoints (authenticated via session.js). */
import { apiFetch } from "../auth/session.js";

export const api = {
  listChats: () => apiFetch("/chats"),
  getChat: (id) => apiFetch(`/chats/${id}`),

  listMessages: (id, { limit = 30, before } = {}) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", before);
    return apiFetch(`/chats/${id}/messages?${q.toString()}`);
  },
  sendMessage: (id, body) =>
    apiFetch(`/chats/${id}/messages`, { method: "POST", body }),
  editMessage: (messageId, content) =>
    apiFetch(`/messages/${messageId}`, { method: "PATCH", body: { content } }),
  getThread: (messageId) => apiFetch(`/messages/${messageId}/thread`),
  messageHistory: (messageId) => apiFetch(`/messages/${messageId}/history`),
  deleteMessage: (messageId) =>
    apiFetch(`/messages/${messageId}`, { method: "DELETE" }),
  addReaction: (messageId, emoji) =>
    apiFetch(`/messages/${messageId}/reactions`, { method: "POST", body: { emoji } }),
  removeReaction: (messageId, emoji) =>
    apiFetch(`/messages/${messageId}/reactions`, { method: "DELETE", body: { emoji } }),
  markRead: (id, messageId) =>
    apiFetch(`/chats/${id}/read`, { method: "POST", body: { messageId } }),

  // Saved Messages (private self-chat).
  getSaved: () => apiFetch("/chats/saved"),
  // Pinned messages.
  listPins: (chatId) => apiFetch(`/chats/${chatId}/pins`),
  pinMessage: (messageId) => apiFetch(`/messages/${messageId}/pin`, { method: "POST" }),
  unpinMessage: (messageId) => apiFetch(`/messages/${messageId}/pin`, { method: "DELETE" }),
  // Link preview (unfurl).
  linkPreview: (url) => apiFetch(`/link-preview?url=${encodeURIComponent(url)}`),

  searchUsers: (q) => apiFetch(`/users/search?q=${encodeURIComponent(q)}`),
  searchMessages: (q) => apiFetch(`/messages/search?q=${encodeURIComponent(q)}`),
  listShared: (chatId, type) => apiFetch(`/chats/${chatId}/shared?type=${type}`),
  createChat: (body) => apiFetch("/chats", { method: "POST", body }),
  createDirect: (otherUserId) =>
    apiFetch("/chats", { method: "POST", body: { type: "direct", memberIds: [otherUserId] } }),

  getUser: (id) => apiFetch(`/users/${id}`),
  updateProfile: (patch) => apiFetch("/users/me", { method: "PATCH", body: patch }),

  // Two-step upload: create the record + target, then PUT the bytes to it.
  createUpload: (meta) => apiFetch("/attachments", { method: "POST", body: meta }),

  // Calls — ICE (STUN/TURN) configuration for WebRTC.
  getIceServers: () => apiFetch("/calls/ice-servers"),

  // Security center — active sessions.
  listSessions: () => apiFetch("/sessions"),
  revokeSession: (id) => apiFetch(`/sessions/${id}`, { method: "DELETE" }),
  revokeOtherSessions: () => apiFetch("/sessions/revoke-others", { method: "POST" }),
};
