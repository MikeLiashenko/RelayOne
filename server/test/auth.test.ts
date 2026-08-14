import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/api";
import { bearer, registerUser } from "./helpers";

const app = createApp();

describe("registration, sessions & users", () => {
  it("creates a user through the full register flow and opens a session", async () => {
    const { token, user } = await registerUser(app, {
      email: "flow@relayone.test",
      username: "flow_user",
    });

    expect(user.username).toBe("flow_user");
    expect(user.email).toBe("flow@relayone.test");
    expect(user.id).toBeTruthy();

    // The session token authenticates /me.
    const me = await request(app).get("/api/users/me").set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(user.id);
  });

  it("rejects an incorrect verification code", async () => {
    const start = await request(app)
      .post("/api/auth/register/start")
      .send({ channel: "email", identifier: "wrongcode@relayone.test" });
    const { verificationId } = start.body.data;

    const verify = await request(app)
      .post("/api/auth/verify")
      .send({ verificationId, code: "000000" });

    expect(verify.status).toBe(400);
    expect(verify.body.error.code).toBe("invalid_code");
  });

  it("enforces case-insensitive username uniqueness", async () => {
    await registerUser(app, { email: "u1@relayone.test", username: "dupe_name" });

    const start = await request(app)
      .post("/api/auth/register/start")
      .send({ channel: "email", identifier: "u2@relayone.test" });
    const { verificationId, devCode } = start.body.data;
    const verify = await request(app)
      .post("/api/auth/verify")
      .send({ verificationId, code: devCode });
    const complete = await request(app)
      .post("/api/auth/register/complete")
      .send({
        registrationTicket: verify.body.data.registrationTicket,
        displayName: "Dupe",
        username: "DUPE_NAME", // different case, same handle
      });

    expect(complete.status).toBe(409);
    expect(complete.body.error.code).toBe("conflict");
  });

  it("blocks unauthenticated access to protected routes", async () => {
    const res = await request(app).get("/api/users/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a tampered/invalid bearer token", async () => {
    const res = await request(app)
      .get("/api/users/me")
      .set(bearer("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  it("logs an existing account in via a fresh code", async () => {
    await registerUser(app, { email: "login@relayone.test", username: "login_user" });

    const start = await request(app)
      .post("/api/auth/login/start")
      .send({ channel: "email", identifier: "login@relayone.test" });
    expect(start.status).toBe(201);

    const verify = await request(app)
      .post("/api/auth/verify")
      .send({ verificationId: start.body.data.verificationId, code: start.body.data.devCode });

    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe("authenticated");
    expect(verify.body.data.session.token).toBeTruthy();
  });

  it("reports username availability", async () => {
    await registerUser(app, { email: "taken@relayone.test", username: "taken_one" });

    const taken = await request(app).get(
      "/api/users/username-available?username=taken_one"
    );
    expect(taken.body.data.available).toBe(false);

    const free = await request(app).get(
      "/api/users/username-available?username=totally_free_1"
    );
    expect(free.body.data.available).toBe(true);
  });
});
