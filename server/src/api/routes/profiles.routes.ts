import { Router } from "express";
import { requireAuth } from "../../auth/middleware";
import { userService } from "../../services/userService";
import { AppError } from "../../shared/errors";
import { toPublicUser } from "../../shared/serialize";
import { asyncHandler, sendData } from "../middleware/http";

export const profilesRouter = Router();

/** Public profile lookup by username. */
profilesRouter.get(
  "/:username",
  requireAuth,
  asyncHandler(async (req, res) => {
    const username = req.params.username ?? "";
    const user = await userService.getByUsername(username);
    if (!user) throw AppError.notFound("Profile not found.");
    sendData(res, toPublicUser(user));
  })
);
