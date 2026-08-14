import { Router } from "express";
import { getAuth, requireAuth } from "../../auth/middleware";
import { attachmentService } from "../../services/attachmentService";
import { parse } from "../../validation/parse";
import { createAttachmentSchema } from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);

/**
 * Create an attachment record + upload target. The client then uploads bytes
 * to `upload.uploadUrl` and references `attachment.id` when sending a message.
 */
attachmentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const input = parse(createAttachmentSchema, req.body);
    const result = await attachmentService.createUpload(user.id, input);
    sendData(res, result, 201);
  })
);
