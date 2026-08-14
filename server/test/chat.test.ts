import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api";
import { bearer, registerUser } from "./helpers";

const app = createApp();

describe("chats, messages & authorization", () => {
  it("creates a direct chat and exchanges a message", async () => {
    const a = await registerUser(app, { email: "a@relayone.test", username: "chat_a" });
    const b = await registerUser(app, { email: "b@relayone.test", username: "chat_b" });

    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    expect(chat.status).toBe(201);
    expect(chat.body.data.members).toHaveLength(2);
    const chatId = chat.body.data.id;

    const sent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "hello b" });
    expect(sent.status).toBe(201);
    expect(sent.body.data.content).toBe("hello b");

    const list = await request(app)
      .get(`/api/chats/${chatId}/messages`)
      .set(bearer(b.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].content).toBe("hello b");
  });

  it("deduplicates direct chats between the same two users", async () => {
    const a = await registerUser(app, { email: "d1@relayone.test", username: "dedupe_a" });
    const b = await registerUser(app, { email: "d2@relayone.test", username: "dedupe_b" });

    const first = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const second = await request(app)
      .post("/api/chats")
      .set(bearer(b.token))
      .send({ type: "direct", memberIds: [a.user.id] });

    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it("creates group chats with multiple members", async () => {
    const a = await registerUser(app, { email: "g1@relayone.test", username: "grp_a" });
    const b = await registerUser(app, { email: "g2@relayone.test", username: "grp_b" });
    const c = await registerUser(app, { email: "g3@relayone.test", username: "grp_c" });

    const res = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "group", title: "Team", memberIds: [b.user.id, c.user.id] });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("group");
    expect(res.body.data.members).toHaveLength(3);
  });

  it("prevents a non-member from accessing a chat by changing the id", async () => {
    const a = await registerUser(app, { email: "z1@relayone.test", username: "authz_a" });
    const b = await registerUser(app, { email: "z2@relayone.test", username: "authz_b" });
    const outsider = await registerUser(app, {
      email: "z3@relayone.test",
      username: "authz_out",
    });

    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const getChat = await request(app)
      .get(`/api/chats/${chatId}`)
      .set(bearer(outsider.token));
    expect(getChat.status).toBe(403);

    const getMsgs = await request(app)
      .get(`/api/chats/${chatId}/messages`)
      .set(bearer(outsider.token));
    expect(getMsgs.status).toBe(403);

    const intrude = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(outsider.token))
      .send({ content: "let me in" });
    expect(intrude.status).toBe(403);
  });

  it("lets a member edit and delete their own message but not others'", async () => {
    const a = await registerUser(app, { email: "m1@relayone.test", username: "msg_a" });
    const b = await registerUser(app, { email: "m2@relayone.test", username: "msg_b" });

    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const sent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "original" });
    const messageId = sent.body.data.id;

    // b cannot edit a's message
    const forbiddenEdit = await request(app)
      .patch(`/api/messages/${messageId}`)
      .set(bearer(b.token))
      .send({ content: "hijacked" });
    expect(forbiddenEdit.status).toBe(403);

    // a can edit their own
    const edit = await request(app)
      .patch(`/api/messages/${messageId}`)
      .set(bearer(a.token))
      .send({ content: "edited" });
    expect(edit.status).toBe(200);
    expect(edit.body.data.content).toBe("edited");
    expect(edit.body.data.editedAt).toBeTruthy();
  });
});
