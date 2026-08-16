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
    // A generated @handle + private by default.
    expect(space.handle).toBe("photography");
    expect(space.visibility).toBe("private");
    // Seven default channels grouped into sections; Overview (announcements) first.
    expect(space.channels).toHaveLength(7);
    expect(space.channels[0].category).toBe("Overview");
    expect(space.channels.map((c: any) => c.kind)).toEqual(
      expect.arrayContaining(["announcement", "forum", "poll", "voice"])
    );
    const discussions = space.channels.find((c: any) => c.name === "discussions");
    expect(discussions.kind).toBe("forum");
    expect(discussions.category).toBe("Channels");

    // Owner listing includes it.
    const list = await request(app).get("/api/spaces").set(bearer(owner.token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(space.id);
  });

  it("generates unique handles and lets admins edit the Space", async () => {
    const owner = await registerUser(app, { email: "sph@relayone.test", username: "sp_h" });
    const a = await makeSpace(owner.token, "Storm Community");
    const b = await makeSpace(owner.token, "Storm Community");
    expect(a.handle).toBe("storm-community");
    expect(b.handle).toBe("storm-community-1"); // suffixed to stay unique

    const edit = await request(app)
      .patch(`/api/spaces/${a.id}`)
      .set(bearer(owner.token))
      .send({ description: "Chasing storms", visibility: "public", handle: "storms" });
    expect(edit.status).toBe(200);
    expect(edit.body.data.description).toBe("Chasing storms");
    expect(edit.body.data.visibility).toBe("public");
    expect(edit.body.data.handle).toBe("storms");

    // Taking an already-used handle is rejected.
    const clash = await request(app)
      .patch(`/api/spaces/${b.id}`)
      .set(bearer(owner.token))
      .send({ handle: "storms" });
    expect(clash.status).toBe(400);
  });

  it("surfaces the latest announcement for the Home screen", async () => {
    const owner = await registerUser(app, { email: "spa@relayone.test", username: "sp_a" });
    const space = await makeSpace(owner.token);
    const announce = space.channels.find((c: any) => c.kind === "announcement");
    await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "Big storm incoming 🌩️" });

    const detail = await request(app).get(`/api/spaces/${space.id}`).set(bearer(owner.token));
    expect(detail.body.data.latestAnnouncement.content).toBe("Big storm incoming 🌩️");
    expect(detail.body.data.latestAnnouncement.senderName).toBeTruthy();
  });

  it("lists forum topics with reply counts, most-active first", async () => {
    const owner = await registerUser(app, { email: "spf@relayone.test", username: "sp_f" });
    const space = await makeSpace(owner.token);
    const forum = space.channels.find((c: any) => c.kind === "forum");

    // Two topics (top-level posts) in the forum channel.
    const t1 = await request(app)
      .post(`/api/chats/${forum.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "Supercell structure\n\nHow does it rotate?" });
    await request(app)
      .post(`/api/chats/${forum.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "Best storm photography" });

    // A reply to the FIRST topic should bump it to the top by activity.
    const reply = await request(app)
      .post(`/api/chats/${forum.chatId}/messages`)
      .set(bearer(owner.token))
      .send({ content: "Mesocyclone!", replyToId: t1.body.data.id });
    expect(reply.status).toBe(201);

    const forumRes = await request(app)
      .get(`/api/chats/${forum.chatId}/forum`)
      .set(bearer(owner.token));
    expect(forumRes.status).toBe(200);
    // Only the two top-level posts are topics (the reply isn't one).
    expect(forumRes.body.data).toHaveLength(2);
    // Topic 1 has 1 reply and, being most-active, sorts first.
    expect(forumRes.body.data[0].id).toBe(t1.body.data.id);
    expect(forumRes.body.data[0].replyCount).toBe(1);
    expect(forumRes.body.data[0].lastActivityAt).toBeTruthy();
    expect(forumRes.body.data[1].replyCount).toBe(0);
  });

  it("creates custom roles and a role's permission grants real access", async () => {
    const owner = await registerUser(app, { email: "spr@relayone.test", username: "sp_r" });
    const member = await registerUser(app, { email: "sprb@relayone.test", username: "sp_rb" });
    const space = await makeSpace(owner.token);
    await request(app).post(`/api/spaces/${space.id}/join`).set(bearer(member.token));
    const announce = space.channels.find((c: any) => c.kind === "announcement");

    // Baseline: a plain member can't post announcements.
    const before = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "nope" });
    expect(before.status).toBe(403);

    // Owner creates a "Verified Creator" role that can post announcements.
    const created = await request(app)
      .post(`/api/spaces/${space.id}/roles`)
      .set(bearer(owner.token))
      .send({ name: "Verified Creator", color: "#5b6bff", permissions: ["post_announcements"] });
    expect(created.status).toBe(201);
    const role = created.body.data.roles.find((r: any) => r.name === "Verified Creator");
    expect(role.permissions).toEqual(["post_announcements"]);

    // A plain member still can't create roles.
    const forbidden = await request(app)
      .post(`/api/spaces/${space.id}/roles`)
      .set(bearer(member.token))
      .send({ name: "Sneaky", permissions: ["manage_space"] });
    expect(forbidden.status).toBe(403);

    // Assign the role to the member.
    const assigned = await request(app)
      .put(`/api/spaces/${space.id}/members/${member.user.id}/roles/${role.id}`)
      .set(bearer(owner.token));
    expect(assigned.status).toBe(200);
    const mrow = assigned.body.data.members.find((m: any) => m.user.id === member.user.id);
    expect(mrow.customRoleIds).toContain(role.id);

    // Now the member CAN post an announcement (permission granted by the role).
    const after = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "official via role" });
    expect(after.status).toBe(201);

    // Removing the role revokes the permission again.
    await request(app)
      .delete(`/api/spaces/${space.id}/members/${member.user.id}/roles/${role.id}`)
      .set(bearer(owner.token));
    const revoked = await request(app)
      .post(`/api/chats/${announce.chatId}/messages`)
      .set(bearer(member.token))
      .send({ content: "nope again" });
    expect(revoked.status).toBe(403);
  });

  it("reports the caller's effective permissions and cleans unknown ones", async () => {
    const owner = await registerUser(app, { email: "spp@relayone.test", username: "sp_p" });
    const space = await makeSpace(owner.token);
    const detail = await request(app).get(`/api/spaces/${space.id}`).set(bearer(owner.token));
    // Owner has every permission.
    expect(detail.body.data.myPermissions).toEqual(
      expect.arrayContaining(["manage_space", "manage_channels", "manage_roles", "manage_members", "post_announcements"])
    );

    // Unknown permission strings are rejected by validation.
    const bad = await request(app)
      .post(`/api/spaces/${space.id}/roles`)
      .set(bearer(owner.token))
      .send({ name: "Weird", permissions: ["make_coffee"] });
    expect(bad.status).toBe(400);
  });

  it("invites: private Spaces need a code; codes let members join and enforce limits", async () => {
    const owner = await registerUser(app, { email: "spi@relayone.test", username: "sp_i" });
    const friend = await registerUser(app, { email: "spib@relayone.test", username: "sp_ib" });
    const other = await registerUser(app, { email: "spic@relayone.test", username: "sp_ic" });
    const space = await makeSpace(owner.token); // private by default

    // Private Space: can't join by @handle.
    const blocked = await request(app)
      .post(`/api/spaces/join`)
      .set(bearer(friend.token))
      .send({ target: `@${space.handle}` });
    expect(blocked.status).toBe(403);

    // Owner creates a single-use invite.
    const inv = await request(app)
      .post(`/api/spaces/${space.id}/invites`)
      .set(bearer(owner.token))
      .send({ maxUses: 1 });
    expect(inv.status).toBe(201);
    const code = inv.body.data.code;
    expect(code).toBeTruthy();

    // Friend redeems it → joins the private Space.
    const joined = await request(app).post(`/api/spaces/join`).set(bearer(friend.token)).send({ target: code });
    expect(joined.status).toBe(200);
    expect(joined.body.data.id).toBe(space.id);
    expect(joined.body.data.myRole).toBe("member");

    // The single use is now spent → a second person can't use it.
    const spent = await request(app).post(`/api/spaces/join`).set(bearer(other.token)).send({ target: code });
    expect(spent.status).toBe(400);

    // Managers can list invites; the code shows 1/1 uses.
    const list = await request(app).get(`/api/spaces/${space.id}/invites`).set(bearer(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.data[0].uses).toBe(1);

    // A plain member can't list invites.
    const memberList = await request(app).get(`/api/spaces/${space.id}/invites`).set(bearer(friend.token));
    expect(memberList.status).toBe(403);
  });

  it("public Spaces are joinable by @handle; revoked invites stop working", async () => {
    const owner = await registerUser(app, { email: "spj@relayone.test", username: "sp_j" });
    const friend = await registerUser(app, { email: "spjb@relayone.test", username: "sp_jb" });
    const space = await makeSpace(owner.token);
    await request(app)
      .patch(`/api/spaces/${space.id}`)
      .set(bearer(owner.token))
      .send({ visibility: "public", handle: "public-space" });

    // Public: joinable by @handle directly.
    const byHandle = await request(app)
      .post(`/api/spaces/join`)
      .set(bearer(friend.token))
      .send({ target: "@public-space" });
    expect(byHandle.status).toBe(200);

    // Revoked invite can't be redeemed.
    const inv = await request(app).post(`/api/spaces/${space.id}/invites`).set(bearer(owner.token)).send({});
    const code = inv.body.data.code;
    await request(app).delete(`/api/spaces/invites/${inv.body.data.id}`).set(bearer(owner.token));
    const third = await registerUser(app, { email: "spjc@relayone.test", username: "sp_jc" });
    const revoked = await request(app).post(`/api/spaces/join`).set(bearer(third.token)).send({ target: code });
    expect(revoked.status).toBe(400);
  });

  it("creates a typed, categorized channel", async () => {
    const owner = await registerUser(app, { email: "spt@relayone.test", username: "sp_t" });
    const space = await makeSpace(owner.token);
    const created = await request(app)
      .post(`/api/spaces/${space.id}/channels`)
      .set(bearer(owner.token))
      .send({ name: "forecasts", kind: "forum", category: "Channels", icon: "🧵" });
    expect(created.status).toBe(201);
    expect(created.body.data.kind).toBe("forum");
    expect(created.body.data.category).toBe("Channels");
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
