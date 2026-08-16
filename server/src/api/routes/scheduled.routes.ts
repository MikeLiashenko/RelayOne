import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { schedulerService } from "../../services/schedulerService";
import { parse } from "../../validation/parse";
import { asyncHandler } from "../middleware/http";

export const scheduledRouter = Router();
scheduledRouter.use(requireAuth);

/** Cancel a pending scheduled message (author only). */
scheduledRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(z.string().uuid(), req.params.id);
    await schedulerService.cancel(id, user.id);
    res.status(204).end();
  })
);
