import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { pollService } from "../../services/pollService";
import { parse } from "../../validation/parse";
import { votePollSchema } from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const pollsRouter = Router();
pollsRouter.use(requireAuth);

const idParam = z.string().uuid();

/** Cast (or replace) the caller's vote on a poll. */
pollsRouter.post(
  "/:id/vote",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { optionIds } = parse(votePollSchema, req.body);
    sendData(res, await pollService.vote(id, user.id, optionIds));
  })
);

/** Close a poll (author only) — stops voting and reveals the quiz answer. */
pollsRouter.post(
  "/:id/close",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await pollService.close(id, user.id));
  })
);
