import type { Express } from "express";
import request from "supertest";

/**
 * Drives the full registration flow through the HTTP API and returns the
 * resulting session token + user. Uses the dev `devCode` returned by the
 * backend in non-production.
 */
export async function registerUser(
  app: Express,
  opts: { email?: string; phone?: string; username: string; displayName?: string }
): Promise<{ token: string; user: any }> {
  const channel = opts.email ? "email" : "phone";
  const identifier = opts.email ?? opts.phone!;

  const start = await request(app)
    .post("/api/auth/register/start")
    .send({ channel, identifier });
  if (start.status !== 201) {
    throw new Error(`register/start failed: ${JSON.stringify(start.body)}`);
  }
  const { verificationId, devCode } = start.body.data;

  const verify = await request(app)
    .post("/api/auth/verify")
    .send({ verificationId, code: devCode });
  if (verify.status !== 200) {
    throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
  }
  const { registrationTicket } = verify.body.data;

  const complete = await request(app)
    .post("/api/auth/register/complete")
    .send({
      registrationTicket,
      displayName: opts.displayName ?? opts.username,
      username: opts.username,
    });
  if (complete.status !== 201) {
    throw new Error(`register/complete failed: ${JSON.stringify(complete.body)}`);
  }

  return { token: complete.body.data.token, user: complete.body.data.user };
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
