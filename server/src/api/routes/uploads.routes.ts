import express, { Router } from "express";
import { getAuth, requireAuth } from "../../auth/middleware";
import { attachmentService } from "../../services/attachmentService";
import { AppError } from "../../shared/errors";
import { getStorage } from "../../storage";
import { asyncHandler } from "../middleware/http";

/**
 * Local object-storage transport (development). In production this role is
 * played by the storage provider's presigned URLs; the messaging code is
 * unaffected either way.
 */
export const uploadsRouter = Router();

function keyFromParams(params: Record<string, unknown>): string {
  return String(params[0] ?? "").replace(/^\/+/, "");
}

/** Upload bytes for a previously created attachment (owner only). */
uploadsRouter.put(
  "/*",
  requireAuth,
  express.raw({ type: () => true, limit: "50mb" }),
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const key = keyFromParams(req.params as Record<string, unknown>);
    const attachment = await attachmentService.assertUploader(key, user.id);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await getStorage().putObject(key, body, attachment.mimeType);
    res.status(204).end();
  })
);

/** Serve stored bytes. (Dev: openly readable; production would gate access.) */
uploadsRouter.get(
  "/*",
  asyncHandler(async (req, res) => {
    const key = keyFromParams(req.params as Record<string, unknown>);
    const object = await getStorage().getObject(key);
    if (!object) throw AppError.notFound("File not found.");
    res.setHeader("content-type", object.contentType);
    res.send(object.data);
  })
);
