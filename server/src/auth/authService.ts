import { and, eq, isNull, sql } from "drizzle-orm";
import { env, exposeDevCodes } from "../config/env";
import { getDb } from "../db";
import { users, verificationCodes, type User } from "../db/schema";
import { AppError } from "../shared/errors";
import { toSelfUser } from "../shared/serialize";
import type { AuthSession } from "../shared/types";
import { generateNumericCode, hashSecret, verifySecret } from "./hashing";
import { createSession, type IssuedSession } from "./sessions";

/**
 * The authentication service. It is UI-independent and transport-independent:
 * the REST layer calls these functions, but so could a future GraphQL layer,
 * a CLI, or additional auth methods (OAuth, passkeys) added alongside.
 *
 * Flow:
 *   register: startRegistration → verify → completeRegistration → session
 *   login:    startLogin        → verify → session
 */

type Channel = "email" | "phone";
type DeviceInput = { name?: string; platform?: string; pushToken?: string };

const REGISTRATION_GRACE_MS = 30 * 60_000;

export interface StartResult {
  verificationId: string;
  channel: Channel;
  purpose: "register" | "login";
  expiresAt: string;
  /** Present only in non-production so the flow is testable without SMS/email. */
  devCode?: string;
}

export type VerifyResult =
  | { status: "registration"; registrationTicket: string }
  | { status: "authenticated"; session: AuthSession };

/* -- Lookups --------------------------------------------------------------- */

async function findUserByIdentifier(
  channel: Channel,
  identifier: string
): Promise<User | undefined> {
  const db = getDb();
  const where =
    channel === "email"
      ? eq(sql`lower(${users.email})`, identifier)
      : eq(users.phone, identifier);
  const [user] = await db.select().from(users).where(where).limit(1);
  return user;
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
    .limit(1);
  return !row;
}

/* -- Code issuance --------------------------------------------------------- */

async function issueCode(params: {
  channel: Channel;
  identifier: string;
  purpose: "register" | "login";
  userId: string | null;
}): Promise<StartResult> {
  const db = getDb();
  const code = generateNumericCode(6);
  const { hash, salt } = hashSecret(code);
  const expiresAt = new Date(
    Date.now() + env.VERIFICATION_CODE_TTL_MINUTES * 60_000
  );

  const [row] = await db
    .insert(verificationCodes)
    .values({
      identifier: params.identifier,
      channel: params.channel,
      purpose: params.purpose,
      userId: params.userId,
      codeHash: hash,
      codeSalt: salt,
      maxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
      expiresAt,
    })
    .returning();

  // Real deployments deliver the code via SMS/email here. In dev/test we
  // surface it so the end-to-end flow works without a provider.
  if (exposeDevCodes) {
    // eslint-disable-next-line no-console
    console.info(`[RelayOne dev] ${params.channel} code for ${params.identifier}: ${code}`);
  }

  return {
    verificationId: row!.id,
    channel: params.channel,
    purpose: params.purpose,
    expiresAt: expiresAt.toISOString(),
    ...(exposeDevCodes ? { devCode: code } : {}),
  };
}

/* -- Public flow ----------------------------------------------------------- */

export async function startRegistration(input: {
  channel: Channel;
  identifier: string;
}): Promise<StartResult> {
  const existing = await findUserByIdentifier(input.channel, input.identifier);
  if (existing) {
    throw AppError.conflict(
      "An account already exists for that contact. Try logging in instead."
    );
  }
  return issueCode({ ...input, purpose: "register", userId: null });
}

export async function startLogin(input: {
  channel: Channel;
  identifier: string;
}): Promise<StartResult> {
  const user = await findUserByIdentifier(input.channel, input.identifier);
  if (!user) {
    // Note: reveals account existence. Acceptable for this first foundation;
    // harden against enumeration before production.
    throw AppError.notFound("No RelayOne account found for that contact.");
  }
  return issueCode({ ...input, purpose: "login", userId: user.id });
}

export async function resendCode(verificationId: string): Promise<StartResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(verificationCodes)
    .where(eq(verificationCodes.id, verificationId))
    .limit(1);
  if (!row || row.consumedAt) {
    throw AppError.notFound("Verification request not found.");
  }
  return issueCode({
    channel: row.channel,
    identifier: row.identifier,
    purpose: row.purpose,
    userId: row.userId,
  });
}

export async function verify(input: {
  verificationId: string;
  code: string;
  device?: DeviceInput;
}): Promise<VerifyResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(verificationCodes)
    .where(eq(verificationCodes.id, input.verificationId))
    .limit(1);

  if (!row) throw AppError.notFound("Verification request not found.");
  if (row.consumedAt)
    throw new AppError(400, "invalid_code", "This code has already been used.");
  if (row.expiresAt.getTime() < Date.now())
    throw new AppError(400, "expired_code", "This code has expired. Request a new one.");
  if (row.attempts >= row.maxAttempts)
    throw new AppError(429, "too_many_attempts", "Too many attempts. Request a new code.");

  if (!verifySecret(input.code, row.codeHash, row.codeSalt)) {
    await db
      .update(verificationCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(verificationCodes.id, row.id));
    throw new AppError(400, "invalid_code", "That code isn't right. Check it and try again.");
  }

  await db
    .update(verificationCodes)
    .set({ consumedAt: new Date() })
    .where(eq(verificationCodes.id, row.id));

  if (row.purpose === "register") {
    return { status: "registration", registrationTicket: row.id };
  }

  if (!row.userId) throw AppError.internal();
  const issued = await createSession(row.userId, input.device);
  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  return { status: "authenticated", session: buildAuthSession(issued, user!) };
}

export async function completeRegistration(input: {
  registrationTicket: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  device?: DeviceInput;
}): Promise<AuthSession> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.id, input.registrationTicket),
        eq(verificationCodes.purpose, "register")
      )
    )
    .limit(1);

  if (!row || !row.consumedAt) {
    throw AppError.unauthorized("Verify your contact before creating a profile.");
  }
  if (Date.now() - row.consumedAt.getTime() > REGISTRATION_GRACE_MS) {
    throw new AppError(400, "expired_code", "Your registration session expired. Please start again.");
  }

  if (!(await isUsernameAvailable(input.username))) {
    throw AppError.conflict("That username is already taken.");
  }

  let user: User;
  try {
    const [created] = await db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName,
        email: row.channel === "email" ? row.identifier : null,
        phone: row.channel === "phone" ? row.identifier : null,
        avatarUrl: input.avatarUrl ?? null,
      })
      .returning();
    user = created!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict("That username or account is already in use.");
    }
    throw err;
  }

  const issued = await createSession(user.id, input.device);
  return buildAuthSession(issued, user);
}

/* -- Helpers --------------------------------------------------------------- */

function buildAuthSession(issued: IssuedSession, user: User): AuthSession {
  return {
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    user: toSelfUser(user),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
