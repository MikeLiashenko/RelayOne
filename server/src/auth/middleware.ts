import type { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors";
import type { Session, User } from "../db/schema";
import { resolveSession } from "./sessions";

/**
 * Express middleware that requires a valid bearer session. On success it
 * attaches `{ user, session }` to `req.auth`.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw AppError.unauthorized();
    }
    const resolved = await resolveSession(token);
    if (!resolved) {
      throw AppError.unauthorized("Your session has expired. Please sign in again.");
    }
    req.auth = resolved;
    next();
  } catch (err) {
    next(err);
  }
}

/** Fetch the authenticated principal, guaranteed present after requireAuth. */
export function getAuth(req: Request): { user: User; session: Session } {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}
