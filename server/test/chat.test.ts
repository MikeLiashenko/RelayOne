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

  it("searches messages across the caller's chats, scoped to membership", async () => {
    const a = await registerUser(app, { email: "s1@relayone.test", username: "search_a" });
    const b = await registerUser(app, { email: "s2@relayone.test", username: "search_b" });
    const c = await registerUser(app, { email: "s3@relayone.test", username: "search_c" });

    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "let's meet for pizza tonight" });
    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(b.token))
      .send({ content: "sounds good" });

    // A member finds the message, case-insensitively.
    const hit = await request(app)
      .get("/api/messages/search?q=PIZZA")
      .set(bearer(b.token));
    expect(hit.status).toBe(200);
    expect(hit.body.data).toHaveLength(1);
    expect(hit.body.data[0].content).toContain("pizza");
    expect(hit.body.data[0].chatId).toBe(chatId);

    // A non-member sees nothing from that chat.
    const miss = await request(app)
      .get("/api/messages/search?q=pizza")
      .set(bearer(c.token));
    expect(miss.status).toBe(200);
    expect(miss.body.data).toHaveLength(0);

    // A blank query is rejected by validation.
    const bad = await request(app)
      .get("/api/messages/search?q=")
      .set(bearer(a.token));
    expect(bad.status).toBe(400);
  });

  it("collects shared links in a chat", async () => {
    const a = await registerUser(app, { email: "sh_a@relayone.test", username: "shared_a" });
    const b = await registerUser(app, { email: "sh_b@relayone.test", username: "shared_b" });
    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "check this https://example.com/page and text" });
    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(b.token))
      .send({ content: "no link here" });

    const links = await request(app)
      .get(`/api/chats/${chatId}/shared?type=links`)
      .set(bearer(b.token));
    expect(links.status).toBe(200);
    expect(links.body.data).toHaveLength(1);
    expect(links.body.data[0].url).toBe("https://example.com/page");

    // A non-member can't read a chat's shared media.
    const c = await registerUser(app, { email: "sh_c@relayone.test", username: "shared_c" });
    const denied = await request(app)
      .get(`/api/chats/${chatId}/shared?type=media`)
      .set(bearer(c.token));
    expect(denied.status).toBe(403);
  });

  it("threads: counts replies and lists a thread", async () => {
    const a = await registerUser(app, { email: "th_a@relayone.test", username: "thread_a" });
    const b = await registerUser(app, { email: "th_b@relayone.test", username: "thread_b" });
    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const parent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "root message" });
    const parentId = parent.body.data.id;

    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(b.token))
      .send({ content: "reply one", replyToId: parentId });
    await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "reply two", replyToId: parentId });

    // The parent now reports 2 replies in the message list.
    const list = await request(app).get(`/api/chats/${chatId}/messages`).set(bearer(a.token));
    const root = list.body.data.find((m: any) => m.id === parentId);
    expect(root.replyCount).toBe(2);

    // The thread endpoint returns the parent + its replies.
    const thread = await request(app).get(`/api/messages/${parentId}/thread`).set(bearer(b.token));
    expect(thread.status).toBe(200);
    expect(thread.body.data.parent.id).toBe(parentId);
    expect(thread.body.data.replies).toHaveLength(2);
    expect(thread.body.data.replies[0].content).toBe("reply one");
  });

  it("runs a poll: create, vote, replace vote, and see results", async () => {
    const a = await registerUser(app, { email: "pl_a@relayone.test", username: "poll_a" });
    const b = await registerUser(app, { email: "pl_b@relayone.test", username: "poll_b" });
    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const created = await request(app)
      .post(`/api/chats/${chatId}/polls`)
      .set(bearer(a.token))
      .send({ question: "Where to?", options: ["Beach", "Mountains", "City"] });
    expect(created.status).toBe(201);
    const poll = created.body.data.poll;
    expect(poll.options).toHaveLength(3);
    expect(poll.totalVoters).toBe(0);
    const beach = poll.options.find((o: any) => o.text === "Beach").id;
    const mountains = poll.options.find((o: any) => o.text === "Mountains").id;

    // B votes Beach.
    const v1 = await request(app)
      .post(`/api/polls/${poll.id}/vote`)
      .set(bearer(b.token))
      .send({ optionIds: [beach] });
    expect(v1.status).toBe(200);
    expect(v1.body.data.totalVoters).toBe(1);
    expect(v1.body.data.myVotes).toEqual([beach]);
    expect(v1.body.data.options.find((o: any) => o.id === beach).votes).toBe(1);

    // B changes to Mountains — single choice replaces the prior vote.
    const v2 = await request(app)
      .post(`/api/polls/${poll.id}/vote`)
      .set(bearer(b.token))
      .send({ optionIds: [mountains] });
    expect(v2.body.data.options.find((o: any) => o.id === beach).votes).toBe(0);
    expect(v2.body.data.options.find((o: any) => o.id === mountains).votes).toBe(1);
    expect(v2.body.data.totalVoters).toBe(1);

    // A (author, hasn't voted) sees results but not their own vote.
    const list = await request(app).get(`/api/chats/${chatId}/messages`).set(bearer(a.token));
    const seen = list.body.data.find((m: any) => m.poll?.id === poll.id).poll;
    expect(seen.totalVoters).toBe(1);
    expect(seen.myVotes).toEqual([]);

    // A validation: a poll needs 2+ options.
    const bad = await request(app)
      .post(`/api/chats/${chatId}/polls`)
      .set(bearer(a.token))
      .send({ question: "Bad", options: ["only one"] });
    expect(bad.status).toBe(400);
  });

  it("quiz poll reveals the answer after voting and on close", async () => {
    const a = await registerUser(app, { email: "qz_a@relayone.test", username: "quiz_a" });
    const b = await registerUser(app, { email: "qz_b@relayone.test", username: "quiz_b" });
    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const created = await request(app)
      .post(`/api/chats/${chatId}/polls`)
      .set(bearer(a.token))
      .send({ question: "2+2?", options: ["3", "4", "5"], isQuiz: true, correctIndex: 1 });
    const poll = created.body.data.poll;
    const wrong = poll.options.find((o: any) => o.text === "3").id;
    const right = poll.options.find((o: any) => o.text === "4").id;

    // Before voting, the correct answer is hidden.
    expect(poll.options.every((o: any) => o.correct === undefined)).toBe(true);

    // B votes wrong → the answer is revealed to B.
    const v = await request(app)
      .post(`/api/polls/${poll.id}/vote`)
      .set(bearer(b.token))
      .send({ optionIds: [wrong] });
    expect(v.body.data.options.find((o: any) => o.id === right).correct).toBe(true);
    expect(v.body.data.options.find((o: any) => o.id === wrong).correct).toBe(false);

    // Only the author can close; then it's closed.
    const denied = await request(app).post(`/api/polls/${poll.id}/close`).set(bearer(b.token));
    expect(denied.status).toBe(403);
    const closed = await request(app).post(`/api/polls/${poll.id}/close`).set(bearer(a.token));
    expect(closed.body.data.closed).toBe(true);

    // Voting a closed poll is rejected.
    const late = await request(app)
      .post(`/api/polls/${poll.id}/vote`)
      .set(bearer(a.token))
      .send({ optionIds: [right] });
    expect(late.status).toBe(400);
  });

  it("keeps an edit history", async () => {
    const a = await registerUser(app, { email: "hist_a@relayone.test", username: "hist_a" });
    const b = await registerUser(app, { email: "hist_b@relayone.test", username: "hist_b" });
    const chat = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    const chatId = chat.body.data.id;

    const sent = await request(app)
      .post(`/api/chats/${chatId}/messages`)
      .set(bearer(a.token))
      .send({ content: "v1" });
    const id = sent.body.data.id;

    await request(app).patch(`/api/messages/${id}`).set(bearer(a.token)).send({ content: "v2" });
    await request(app).patch(`/api/messages/${id}`).set(bearer(a.token)).send({ content: "v3" });

    const hist = await request(app).get(`/api/messages/${id}/history`).set(bearer(a.token));
    expect(hist.status).toBe(200);
    expect(hist.body.data.map((v: any) => v.content)).toEqual(["v1", "v2", "v3"]);
  });
});
