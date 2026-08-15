import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import {
  listActiveSessions,
  revokeOtherSessions,
  revokeSessionForUser,
} from "../../auth/sessions";
import { parse } from "../../validation/parse";
import { asyncHandler, sendData } from "../middleware/http";

/**
 * Security center — a user's active sessions, and the ability to sign other
 * devices out. Each row is one device/browser login.
 */
export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);

/** List the caller's active sessions, flagging the current one. */
sessionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { user, session } = getAuth(req);
    const rows = await listActiveSessions(user.id);
    sendData(
      res,
      rows.map((s) => ({
        id: s.id,
        current: s.id === session.id,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      }))
    );
  })
);

/** Sign out every other device, keeping the current session. */
sessionsRouter.post(
  "/revoke-others",
  asyncHandler(async (req, res) => {
    const { user, session } = getAuth(req);
    await revokeOtherSessions(user.id, session.id);
    res.status(204).end();
  })
);

/** Revoke a specific session (only the caller's own). */
sessionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    await revokeSessionForUser(id, user.id);
    res.status(204).end();
  })
);
