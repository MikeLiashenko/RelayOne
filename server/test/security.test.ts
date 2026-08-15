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
