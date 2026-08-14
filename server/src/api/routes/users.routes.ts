import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { userService } from "../../services/userService";
import { AppError } from "../../shared/errors";
import { toPublicUser, toSelfUser } from "../../shared/serialize";
import { parse } from "../../validation/parse";
import {
  updateProfileSchema,
  usernameQuerySchema,
  usernameSchema,
  userSearchSchema,
} from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const usersRouter = Router();

/** Public: username availability, used live by the registration UI. */
usersRouter.get(
  "/username-available",
  asyncHandler(async (req, res) => {
    const { username } = parse(usernameQuerySchema, req.query);
    const formatOk = usernameSchema.safeParse(username).success;
    const available = formatOk && (await userService.isUsernameAvailable(username));
    sendData(res, { username, valid: formatOk, available });
  })
);

/** Find users by username / display name to start a new chat. */
usersRouter.get(
  "/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const { q } = parse(userSearchSchema, req.query);
    const results = await userService.search(q, user.id);
    sendData(res, results.map(toPublicUser));
  })
);

usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    sendData(res, toSelfUser(user));
  })
);

usersRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const patch = parse(updateProfileSchema, req.body);
    const updated = await userService.updateProfile(user.id, patch);
    sendData(res, toSelfUser(updated));
  })
);

usersRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const user = await userService.getById(id);
    if (!user) throw AppError.notFound("User not found.");
    sendData(res, toPublicUser(user));
  })
);
