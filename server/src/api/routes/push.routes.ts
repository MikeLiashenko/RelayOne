import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { pushService } from "../../services/pushService";
import { parse } from "../../validation/parse";
import { asyncHandler, sendData } from "../middleware/http";

export const pushRouter = Router();

/** The VAPID public key the browser needs to create a subscription. Public. */
pushRouter.get(
  "/vapid-public-key",
  asyncHandler(async (_req, res) => {
    sendData(res, { key: pushService.publicKey(), enabled: pushService.isEnabled() });
  })
);

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/** Register this browser's push subscription for the caller. */
pushRouter.post(
  "/subscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const sub = parse(subscriptionSchema, req.body);
    await pushService.subscribe(user.id, sub);
    res.status(204).end();
  })
);

/** Remove a push subscription (on disable / sign-out). */
pushRouter.post(
  "/unsubscribe",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().url() }), req.body);
    await pushService.unsubscribe(endpoint);
    res.status(204).end();
  })
);
