import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware";
import { linkPreviewService } from "../../services/linkPreviewService";
import { parse } from "../../validation/parse";
import { asyncHandler, sendData } from "../middleware/http";

/**
 * Link preview (unfurl) endpoint. The heavy lifting + SSRF protection live in
 * linkPreviewService; this just validates the URL and returns the card.
 */
export const linkRouter = Router();

linkRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { url } = parse(z.object({ url: z.string().url().max(2048) }), req.query);
    sendData(res, await linkPreviewService.preview(url));
  })
);
