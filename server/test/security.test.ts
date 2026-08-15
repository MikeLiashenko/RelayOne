import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api";
import { bearer, registerUser } from "./helpers";

const app = createApp();

/** Sign the same user in again to create a second, independent session. */
async function loginAgain(email: string): Promise<string> {
  const start = await request(app)
    .post("/api/auth/login/start")
    .send({ channel: "email", identifier: email });
  const { verificationId, devCode } = start.body.data;
  const verify = await request(app)
    .post("/api/auth/verify")
    .send({ verificationId, code: devCode });
  return verify.body.data.session.token;
}

describe("security center — sessions", () => {
  it("lists sessions, flags the current one, and revokes others", async () => {
    const email = "sess_a@relayone.test";
    const a = await registerUser(app, { email, username: "sess_a" });
    const token2 = await loginAgain(email);

    // From token2's view: two active sessions, exactly one current.
    const list = await request(app).get("/api/sessions").set(bearer(token2));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);

    // Revoke the other (token1's) session.
    const other = list.body.data.find((s: any) => !s.current);
    const del = await request(app).delete(`/api/sessions/${other.id}`).set(bearer(token2));
    expect(del.status).toBe(204);

    // token1 no longer works; token2 still does.
    const withOld = await request(app).get("/api/sessions").set(bearer(a.token));
    expect(withOld.status).toBe(401);
    const withNew = await request(app).get("/api/sessions").set(bearer(token2));
    expect(withNew.body.data).toHaveLength(1);
  });

  it("revoke-others keeps only the current session", async () => {
    const email = "sess_b@relayone.test";
    await registerUser(app, { email, username: "sess_b" });
    const token2 = await loginAgain(email);
    await loginAgain(email); // a third session

    let list = await request(app).get("/api/sessions").set(bearer(token2));
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);

    const res = await request(app).post("/api/sessions/revoke-others").set(bearer(token2));
    expect(res.status).toBe(204);

    list = await request(app).get("/api/sessions").set(bearer(token2));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].current).toBe(true);
  });
});

describe("privacy — who can message + avatar visibility", () => {
  it("enforces message privacy (everyone / contacts / nobody)", async () => {
    const a = await registerUser(app, { email: "pv_a@relayone.test", username: "pv_a" });
    const b = await registerUser(app, { email: "pv_b@relayone.test", username: "pv_b" });
    const c = await registerUser(app, { email: "pv_c@relayone.test", username: "pv_c" });

    // Default (everyone): A can DM B.
    const ok = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [b.user.id] });
    expect(ok.status).toBe(201);

    // C blocks everyone.
    await request(app)
      .patch("/api/users/me")
      .set(bearer(c.token))
      .send({ privacy: { messages: "nobody" } });
    const blocked = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [c.user.id] });
    expect(blocked.status).toBe(403);

    // C switches to contacts-only: still blocked (A shares no chat with C)…
    await request(app)
      .patch("/api/users/me")
      .set(bearer(c.token))
      .send({ privacy: { messages: "contacts" } });
    const stillBlocked = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [c.user.id] });
    expect(stillBlocked.status).toBe(403);

    // …until they share a group; then A can DM C.
    await request(app)
      .post("/api/chats")
      .set(bearer(b.token))
      .send({ type: "group", title: "Shared", memberIds: [a.user.id, c.user.id] });
    const nowOk = await request(app)
      .post("/api/chats")
      .set(bearer(a.token))
      .send({ type: "direct", memberIds: [c.user.id] });
    expect(nowOk.status).toBe(201);
  });

  it("hides the avatar of a stranger who set avatar privacy to nobody", async () => {
    const a = await registerUser(app, { email: "av_a@relayone.test", username: "av_a" });
    const b = await registerUser(app, { email: "av_b@relayone.test", username: "av_seeker" });

    await request(app)
      .patch("/api/users/me")
      .set(bearer(b.token))
      .send({ avatarUrl: "https://example.com/b.png", privacy: { avatar: "nobody" } });

    // A (a stranger) searches for B → avatar withheld.
    const search = await request(app)
      .get("/api/users/search?q=av_seeker")
      .set(bearer(a.token));
    const found = search.body.data.find((u: any) => u.id === b.user.id);
    expect(found).toBeTruthy();
    expect(found.avatarUrl).toBeNull();

    // B still sees their own avatar.
    const me = await request(app).get("/api/users/me").set(bearer(b.token));
    expect(me.body.data.avatarUrl).toBe("https://example.com/b.png");
    expect(me.body.data.privacy.avatar).toBe("nobody");
  });
});

describe("web push — endpoints", () => {
  it("serves the VAPID public key (disabled without a private key in tests)", async () => {
    const r = await request(app).get("/api/push/vapid-public-key");
    expect(r.status).toBe(200);
    expect(typeof r.body.data.key).toBe("string");
    expect(r.body.data.enabled).toBe(false);
  });

  it("validates and stores a subscription", async () => {
    const a = await registerUser(app, { email: "push_a@relayone.test", username: "push_a" });

    const bad = await request(app)
      .post("/api/push/subscribe")
      .set(bearer(a.token))
      .send({ endpoint: "not-a-url" });
    expect(bad.status).toBe(400);

    const good = await request(app)
      .post("/api/push/subscribe")
      .set(bearer(a.token))
      .send({
        endpoint: "https://push.example.com/abc123",
        keys: { p256dh: "BKp256dhKeyValue", auth: "authSecretValue" },
      });
    expect(good.status).toBe(204);
  });
});
