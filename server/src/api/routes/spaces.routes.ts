import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { spaceService } from "../../services/spaceService";
import { parse } from "../../validation/parse";
import {
  createSpaceChannelSchema,
  createSpaceSchema,
  updateSpaceMemberSchema,
  updateSpaceSchema,
} from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const spacesRouter = Router();
spacesRouter.use(requireAuth);

const idParam = z.string().uuid();

/** Spaces the caller belongs to. */
spacesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    sendData(res, await spaceService.listForUser(user.id));
  })
);

/** Create a Space (seeds default channels; caller becomes owner). */
spacesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const input = parse(createSpaceSchema, req.body);
    sendData(res, await spaceService.createSpace(user.id, input), 201);
  })
);

/** Delete a channel (admin+). Path is fixed, so it precedes "/:id" routes. */
spacesRouter.delete(
  "/channels/:channelId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const channelId = parse(idParam, req.params.channelId);
    await spaceService.deleteChannel(channelId, user.id);
    res.status(204).end();
  })
);

/** Full Space view (members only). */
spacesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await spaceService.getDetail(id, user.id));
  })
);

/** Edit a Space's object fields — name, handle, description, avatar, banner (admin+). */
spacesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const patch = parse(updateSpaceSchema, req.body);
    sendData(res, await spaceService.updateSpace(id, user.id, patch));
  })
);

/** Delete a Space (owner only). */
spacesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    await spaceService.deleteSpace(id, user.id);
    res.status(204).end();
  })
);

/** Join a Space. */
spacesRouter.post(
  "/:id/join",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await spaceService.join(id, user.id));
  })
);

/** Leave a Space (owners must delete it). */
spacesRouter.post(
  "/:id/leave",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    await spaceService.leave(id, user.id);
    res.status(204).end();
  })
);

/** Create a channel in a Space (admin+). */
spacesRouter.post(
  "/:id/channels",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const input = parse(createSpaceChannelSchema, req.body);
    sendData(res, await spaceService.createChannel(id, user.id, input), 201);
  })
);

/** Change a member's role (owner, or admin acting below themselves). */
spacesRouter.patch(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const targetId = parse(idParam, req.params.userId);
    const { role } = parse(updateSpaceMemberSchema, req.body);
    sendData(res, await spaceService.setRole(id, user.id, targetId, role));
  })
);

/** Remove a member from a Space (admin+). */
spacesRouter.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const targetId = parse(idParam, req.params.userId);
    await spaceService.kick(id, user.id, targetId);
    res.status(204).end();
  })
);
