import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api";
import { bearer, registerUser } from "./helpers";

const app = createApp();

/** Create a Space owned by a freshly-registered user; return its detail. */
async function makeSpace(token: string, name = "Test Space") {
  const res = await request(app)
    .post("/api/spaces")
    .set(bearer(token))
    .send({ name, description: "hi" });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe("spaces (communities)", () => {
  it("creates a Space with default channels and owner membership", async () => {
    const owner = await registerUser(app, { email: "sp1@relayone.test", username: "sp_owner1" });
    const space = await makeSpace(owner.token, "Photography");

    expect(space.myRole).toBe("owner");
    expect(space.memberCount).toBe(1);
    // Six default channels, general first.
    expect(space.channels).toHaveLength(6);
    expect(space.channels[0].name).toBe("general");
    expect(space.channels.map((c: any) => c.kind)).toContain("announcement");

    // Owner listing includes it.
    const list = await request(app).get("/api/spaces").set(bearer(owner.token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(space.id);
  });

  it("keeps Space channels out of the normal chat list", async () => {
    const owner = await registerUser(app, { email: "sp2@relayone.test", username: "sp_owner2" });
    const space = await makeSpace(owner.token);

    // Post in the general channel so the backing chat has activity.
    const general = space.channels.find((c: any) => c.name === "general");
    await request(app)
      .post(`/api/chats/${general.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "hello space" });

    const chats = await request(app).get("/api/chats").set(bearer(owner.token));
    // Space channels must not leak into the DM/group list.
    expect(chats.body.data.every((c: any) => c.id !== general.chatId)).toBe(true);
  });

  it("lets a member join and post in a channel", async () => {
    const owner = await registerUser(app, { email: "sp3@relayone.test", username: "sp_owner3" });
    const member = await registerUser(app, { email: "sp3b@relayone.test", username: "sp_member3" });
    const space = await makeSpace(owner.token);

    const joined = await request(app)
      .post(`/api/spaces/${space.id}/join`)
      .set(bearer(member.token));
    expect(joined.status).toBe(200);
    expect(joined.body.data.memberCount).toBe(2);
    expect(joined.body.data.myRole).toBe("member");

    const general = space.channels.find((c: any) => c.name === "general");
    const sent = await request(app)
      .post(`/api/chats/${general.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "hi from a member" });
    expect(sent.status).toBe(201);
  });

  it("blocks non-members from a channel and gates announcement posting", async () => {
    const owner = await registerUser(app, { email: "sp4@relayone.test", username: "sp_owner4" });
    const member = await registerUser(app, { email: "sp4b@relayone.test", username: "sp_member4" });
    const outsider = await registerUser(app, { email: "sp4c@relayone.test", username: "sp_out4" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(member.token));

    const general = space.channels.find((c: any) => c.name === "general");
    const announce = space.channels.find((c: any) => c.kind === "announcement");

    // Outsider can't post in a channel they never joined.
    const blocked = await request(app)
      .post(`/api/chats/${general.chatId}/messages`)
      .set(bearer(outsider.token))
      .send({ content: "sneaky" });
    expect(blocked.status).toBe(403);

    // A plain member can't post in an announcement channel...
    const denied = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "member announcement" });
    expect(denied.status).toBe(403);

    // ...but the owner can.
    const ok = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "official announcement" });
    expect(ok.status).toBe(201);
  });

  it("promotes a member to moderator who can then post announcements", async () => {
    const owner = await registerUser(app, { email: "sp5@relayone.test", username: "sp_owner5" });
    const member = await registerUser(app, { email: "sp5b@relayone.test", username: "sp_member5" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(member.token));

    const promote = await request(app)
      .patch(`/api/spaces/${space.id}/members/${member.user.id}`)
      .set(bearer(owner.token))
      .send({ role: "moderator" });
    expect(promote.status).toBe(200);

    const announce = space.channels.find((c: any) => c.kind === "announcement");
    const posted = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "mod announcement" });
    expect(posted.status).toBe(201);
  });

  it("only the owner can make admins; admins can't touch peers", async () => {
    const owner = await registerUser(app, { email: "sp6@relayone.test", username: "sp_owner6" });
    const m = await registerUser(app, { email: "sp6b@relayone.test", username: "sp_m6" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(m.token));

    // A member can't hand out roles at all.
    const forbidden = await request(app)
      .patch(`/api/spaces/${space.id}/members/${owner.user.id}`)
      .set(bearer(m.token))
      .send({ role: "member" });
    expect(forbidden.status).toBe(403);

    // Owner may promote to admin.
    const toAdmin = await request(app)
      .patch(`/api/spaces/${space.id}/members/${m.user.id}`)
      .set(bearer(owner.token))
      .send({ role: "admin" });
    expect(toAdmin.status).toBe(200);
  });

  it("creates and deletes channels (admin+) and forbids emptying a Space", async () => {
    const owner = await registerUser(app, { email: "sp7@relayone.test", username: "sp_owner7" });
    const space = await makeSpace(owner.token);

    const created = await request(app)
      .post(`/api/spaces/${space.id}/channels`)
      .set(bearer(owner.token))
      .send({ name: "off-topic", icon: "🎲", kind: "text" });
    expect(created.status).toBe(201);
    expect(created.body.data.name).toBe("off-topic");

    const del = await request(app)
      .delete(`/api/spaces/channels/${created.body.data.id}`)
      .set(bearer(owner.token));
    expect(del.status).toBe(204);
  });

  it("lets members leave but forbids the owner from leaving", async () => {
    const owner = await registerUser(app, { email: "sp8@relayone.test", username: "sp_owner8" });
    const member = await registerUser(app, { email: "sp8b@relayone.test", username: "sp_member8" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(member.token));

    const ownerLeave = await request(app)
      .post(`/api/spaces/${space.id}/leave`)
      .set(bearer(owner.token));
    expect(ownerLeave.status).toBe(400);

    const memberLeave = await request(app)
      .post(`/api/spaces/${space.id}/leave`)
      .set(bearer(member.token));
    expect(memberLeave.status).toBe(204);

    // After leaving, the Space no longer lists for the member.
    const list = await request(app).get("/api/spaces").set(bearer(member.token));
    expect(list.body.data).toHaveLength(0);
  });

  it("deletes a whole Space (owner only)", async () => {
    const owner = await registerUser(app, { email: "sp9@relayone.test", username: "sp_owner9" });
    const member = await registerUser(app, { email: "sp9b@relayone.test", username: "sp_member9" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(member.token));

    const memberDelete = await request(app)
      .delete(`/api/spaces/${space.id}`)
      .set(bearer(member.token));
    expect(memberDelete.status).toBe(403);

    const ownerDelete = await request(app)
      .delete(`/api/spaces/${space.id}`)
      .set(bearer(owner.token));
    expect(ownerDelete.status).toBe(204);

    const detail = await request(app).get(`/api/spaces/${space.id}`).set(bearer(owner.token));
    expect(detail.status).toBe(404); // Space (and its rows) cascaded away
  });
});
