import { Router } from "express";
import { z } from "zod";
import * as authService from "../../auth/authService";
import { getAuth, requireAuth } from "../../auth/middleware";
import { revokeSession } from "../../auth/sessions";
import { AppError } from "../../shared/errors";
import { parse } from "../../validation/parse";
import {
  completeProfileSchema,
  identifierSchema,
  verifySchema,
} from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";
import { authLimiter } from "../middleware/rateLimit";

export const authRouter = Router();

// All auth endpoints are rate-limited.
authRouter.use(authLimiter);

/** Register: step 1 — issue a verification code for a new account. */
authRouter.post(
  "/register/start",
  asyncHandler(async (req, res) => {
    const input = parse(identifierSchema, req.body);
    const result = await authService.startRegistration(input);
    sendData(res, result, 201);
  })
);

/** Login: step 1 — issue a verification code for an existing account. */
authRouter.post(
  "/login/start",
  asyncHandler(async (req, res) => {
    const input = parse(identifierSchema, req.body);
    const result = await authService.startLogin(input);
    sendData(res, result, 201);
  })
);

/** Re-issue a code for an in-flight verification. */
authRouter.post(
  "/resend",
  asyncHandler(async (req, res) => {
    const { verificationId } = parse(
      z.object({ verificationId: z.string().uuid() }),
      req.body
    );
    const result = await authService.resendCode(verificationId);
    sendData(res, result);
  })
);

/**
 * Step 2 — verify a code. For login this returns an authenticated session; for
 * registration it returns a short-lived ticket for profile creation.
 */
authRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const input = parse(verifySchema, req.body);
    const result = await authService.verify(input);
    sendData(res, result);
  })
);

/** Register: step 3 — create the profile and open a session. */
authRouter.post(
  "/register/complete",
  asyncHandler(async (req, res) => {
    const input = parse(completeProfileSchema, req.body);
    const session = await authService.completeRegistration(input);
    sendData(res, session, 201);
  })
);

/** End the current session (this device only). */
authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { session } = getAuth(req);
    await revokeSession(session.id);
    res.status(204).end();
  })
);
