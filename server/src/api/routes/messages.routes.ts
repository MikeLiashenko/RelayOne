import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { messageService } from "../../services/messageService";
import { parse } from "../../validation/parse";
import { editMessageSchema, reactionSchema } from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const idParam = z.string().uuid();
const searchQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });

/** Global search across the caller's chats, by message text. */
messagesRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const { q } = parse(searchQuerySchema, req.query);
    sendData(res, await messageService.search(user.id, q, { limit: 20 }));
  })
);

/** Edit your own message. */
messagesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { content } = parse(editMessageSchema, req.body);
    sendData(res, await messageService.edit(id, user.id, content));
  })
);

/** Soft-delete your own message. */
messagesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    await messageService.remove(id, user.id);
    res.status(204).end();
  })
);

/** Pin a message. */
messagesRouter.post(
  "/:id/pin",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await messageService.setPinned(id, user.id, true));
  })
);

/** Unpin a message. */
messagesRouter.delete(
  "/:id/pin",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await messageService.setPinned(id, user.id, false));
  })
);

/** Add a reaction. */
messagesRouter.post(
  "/:id/reactions",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { emoji } = parse(reactionSchema, req.body);
    await messageService.addReaction(id, user.id, emoji);
    res.status(204).end();
  })
);

/** Remove a reaction. */
messagesRouter.delete(
  "/:id/reactions",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { emoji } = parse(reactionSchema, req.body);
    await messageService.removeReaction(id, user.id, emoji);
    res.status(204).end();
  })
);
