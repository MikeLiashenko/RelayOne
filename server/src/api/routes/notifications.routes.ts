import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { notificationService } from "../../services/notificationService";
import { parse } from "../../validation/parse";
import { asyncHandler, sendData } from "../middleware/http";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/** List the caller's notifications. */
notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const query = parse(listQuery, req.query);
    sendData(
      res,
      await notificationService.list(user.id, {
        limit: query.limit,
        unreadOnly: query.unreadOnly,
      })
    );
  })
);

/** Mark all notifications read. */
notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    await notificationService.markAllRead(user.id);
    res.status(204).end();
  })
);

/** Mark a single notification read. */
notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    await notificationService.markRead(id, user.id);
    res.status(204).end();
  })
);
