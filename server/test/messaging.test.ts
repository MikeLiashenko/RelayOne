import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api";
import { attachRealtime } from "../src/realtime/gateway";
import { bearer, registerUser } from "./helpers";

const app = createApp();
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer(app);
  attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  // Force-close sockets so the server can shut down promptly.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A WebSocket client that buffers events and lets tests await specific ones. */
function connect(token: string) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
  const events: any[] = [];
  const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];

  ws.on("message", (data) => {
    const ev = JSON.parse(data.toString());
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.pred(ev)) {
        waiters[i]!.resolve(ev);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    waitFor(pred: (e: any) => boolean, ms = 4000): Promise<any> {
      const existing = events.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error("timed out waiting for realtime event"));
          }
        }, ms);
      });
    },
    send(obj: unknown) {
      ws.send(JSON.stringify(obj));
    },
    close() {
      ws.close();
    },
  };
}

async function createDirect(token: string, otherId: string): Promise<string> {
  const res = await request(app)
    .post("/api/chats")
    .set(bearer(token))
    .send({ type: "direct", memberIds: [otherId] });
  return res.body.data.id;
}

describe("user search", () => {
  it("finds users by username and display name, excluding self", async () => {
    const a = await registerUser(app, {
      email: "srch_a@relayone.test",
      username: "searcher_one",
      displayName: "Ada Seeker",
    });
    await registerUser(app, {
      email: "srch_b@relayone.test",
      username: "findme_two",
      displayName: "Grace Target",
    });

    const byUsername = await request(app)
      .get("/api/users/search?q=findme")
      .set(bearer(a.token));
    expect(byUsername.status).toBe(200);
    expect(byUsername.body.data.some((u: any) => u.username === "findme_two")).toBe(true);

    const byName = await request(app)
      .get("/api/users/search?q=Grace")
      .set(bearer(a.token));
    expect(byName.body.data.some((u: any) => u.username === "findme_two")).toBe(true);

    const self = await request(app)
      .get("/api/users/search?q=Ada")
      .set(bearer(a.token));
    expect(self.body.data.some((u: any) => u.id === a.user.id)).toBe(false);
  });
});

describe("chat summaries & read receipts", () => {
  it("reports last message, unread count and read state", async () => {
    const a = await registerUser(app, { email: "sum_a@relayone.test", username: "sum_a" });
    const b = await registerUser(app, { email: "sum_b@relayone.test", username: "sum_b" });
    const chatId = await createDirect(a.token, b.user.id);

    const sent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "hello there" });
    const messageId = sent.body.data.id;

    // From B's list: last message + one unread.
    let list = await request(app).get("/api/chats").set(bearer(b.token));
    let chat = list.body.data.find((c: any) => c.id === chatId);
    expect(chat.lastMessage.content).toBe("hello there");
    expect(chat.unreadCount).toBe(1);

    // B reads.
    await request(app)
      .post(`/api/chats/${chatId}/read`)
      .set(bearer(b.token))
      .send({ messageId });

    list = await request(app).get("/api/chats").set(bearer(b.token));
    chat = list.body.data.find((c: any) => c.id === chatId);
    expect(chat.unreadCount).toBe(0);

    // A sees B's read state on the chat detail.
    const detail = await request(app).get(`/api/chats/${chatId}`).set(bearer(a.token));
    const bState = detail.body.data.memberStates.find((m: any) => m.userId === b.user.id);
    expect(bState.lastReadMessageId).toBe(messageId);
    expect(bState.lastReadAt).toBeTruthy();
  });
});

describe("replies", () => {
  it("allows replying within a chat but not across chats", async () => {
    const a = await registerUser(app, { email: "rep_a@relayone.test", username: "rep_a" });
    const b = await registerUser(app, { email: "rep_b@relayone.test", username: "rep_b" });
    const c = await registerUser(app, { email: "rep_c@relayone.test", username: "rep_c" });

    const chat1 = await createDirect(a.token, b.user.id);
    const chat2 = await createDirect(a.token, c.user.id);

    const parent = await request(app)
      .post(`/api/chats/${chat1}/messages`)
      .set(bearer(a.token))
      .send({ content: "parent" });
    const parentId = parent.body.data.id;

    const validReply = await request(app)
      .post(`/api/chats/${chat1}/messages`)
      .set(bearer(b.token))
      .send({ content: "reply", replyToId: parentId });
    expect(validReply.status).toBe(201);
    expect(validReply.body.data.replyTo.id).toBe(parentId);
    expect(validReply.body.data.replyTo.content).toBe("parent");

    // Replying to chat1's message from within chat2 must be rejected.
    const crossReply = await request(app)
      .post(`/api/chats/${chat2}/messages`)
      .set(bearer(a.token))
      .send({ content: "sneaky", replyToId: parentId });
    expect(crossReply.status).toBe(400);
  });
});

describe("realtime — two clients", () => {
  it("delivers messages, reactions, edits, deletes, typing, presence, read", async () => {
    const a = await registerUser(app, { email: "rt_a@relayone.test", username: "rt_a" });
    const b = await registerUser(app, { email: "rt_b@relayone.test", username: "rt_b" });
    const chatId = await createDirect(a.token, b.user.id);

    const wsB = connect(b.token);
    await wsB.waitFor((e) => e.type === "ready");

    const wsA = connect(a.token);
    await wsA.waitFor((e) => e.type === "ready");

    // Presence: B learns A came online.
    const presence = await wsB.waitFor(
      (e) => e.type === "presence" && e.userId === a.user.id && e.online === true
    );
    expect(presence.online).toBe(true);

    // A sends → B receives without refresh.
    const sent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "realtime hi" });
    const messageId = sent.body.data.id;
    const newEv = await wsB.waitFor((e) => e.type === "message.new");
    expect(newEv.message.content).toBe("realtime hi");

    // B reacts → A receives.
    await request(app)
      .post(`/api/messages/${messageId}/reactions`)
      .set(bearer(b.token))
      .send({ emoji: "👍" });
    const rx = await wsA.waitFor((e) => e.type === "message.reaction" && e.op === "add");
    expect(rx.emoji).toBe("👍");

    // A edits → B receives.
    await request(app)
      .patch(`/api/messages/${messageId}`)
      .set(bearer(a.token))
      .send({ content: "realtime edited" });
    const edited = await wsB.waitFor((e) => e.type === "message.edited");
    expect(edited.message.content).toBe("realtime edited");

    // B typing → A receives.
    wsB.send({ type: "typing", chatId, isTyping: true });
    const typing = await wsA.waitFor((e) => e.type === "typing");
    expect(typing.userId).toBe(b.user.id);
    expect(typing.isTyping).toBe(true);

    // B read receipt → A receives.
    wsB.send({ type: "read", chatId, messageId });
    const read = await wsA.waitFor((e) => e.type === "read" && e.userId === b.user.id);
    expect(read.lastReadMessageId).toBe(messageId);

    // A deletes → B receives.
    await request(app).delete(`/api/messages/${messageId}`).set(bearer(a.token));
    const deleted = await wsB.waitFor((e) => e.type === "message.deleted");
    expect(deleted.messageId).toBe(messageId);

    wsA.close();
    wsB.close();
  });
});
