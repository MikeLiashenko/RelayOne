import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { spaceService } from "../../services/spaceService";
import { parse } from "../../validation/parse";
import {
  createSpaceChannelSchema,
  createSpaceInviteSchema,
  createSpaceRoleSchema,
  createSpaceSchema,
  joinSpaceSchema,
  updateSpaceMemberSchema,
  updateSpaceRoleSchema,
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

/** Join a Space by invite code, @handle, or id. Fixed path → precedes "/:id". */
spacesRouter.post(
  "/join",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const { target } = parse(joinSpaceSchema, req.body);
    sendData(res, await spaceService.resolveJoin(target, user.id));
  })
);

/** Revoke an invite (creator or manage_members). Fixed path → precedes "/:id". */
spacesRouter.delete(
  "/invites/:inviteId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const inviteId = parse(idParam, req.params.inviteId);
    await spaceService.revokeInvite(inviteId, user.id);
    res.status(204).end();
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

/** Create a shareable invite for a Space (any member). */
spacesRouter.post(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const input = parse(createSpaceInviteSchema, req.body);
    sendData(res, await spaceService.createInvite(id, user.id, input), 201);
  })
);

/** List a Space's active invites (needs manage_members). */
spacesRouter.get(
  "/:id/invites",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await spaceService.listInvites(id, user.id));
  })
);

/* -- Custom roles ---------------------------------------------------------- */

/** Create a custom role in a Space (needs manage_roles). */
spacesRouter.post(
  "/:id/roles",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const input = parse(createSpaceRoleSchema, req.body);
    sendData(res, await spaceService.createRole(id, user.id, input), 201);
  })
);

/** Edit a custom role. */
spacesRouter.patch(
  "/:id/roles/:roleId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const roleId = parse(idParam, req.params.roleId);
    const patch = parse(updateSpaceRoleSchema, req.body);
    sendData(res, await spaceService.updateRole(roleId, user.id, patch));
  })
);

/** Delete a custom role. */
spacesRouter.delete(
  "/:id/roles/:roleId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const roleId = parse(idParam, req.params.roleId);
    await spaceService.deleteRole(roleId, user.id);
    res.status(204).end();
  })
);

/** Assign a custom role to a member. */
spacesRouter.put(
  "/:id/members/:userId/roles/:roleId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const targetId = parse(idParam, req.params.userId);
    const roleId = parse(idParam, req.params.roleId);
    sendData(res, await spaceService.setRoleAssignment(id, user.id, targetId, roleId, true));
  })
);

/** Remove a custom role from a member. */
spacesRouter.delete(
  "/:id/members/:userId/roles/:roleId",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const targetId = parse(idParam, req.params.userId);
    const roleId = parse(idParam, req.params.roleId);
    sendData(res, await spaceService.setRoleAssignment(id, user.id, targetId, roleId, false));
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
