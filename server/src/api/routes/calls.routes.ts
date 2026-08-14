import { Router } from "express";
import { requireAuth } from "../../auth/middleware";
import { env } from "../../config/env";
import { asyncHandler, sendData } from "../middleware/http";

/**
 * RelayOne Calls — REST surface.
 *
 * Serves the ICE server list to authenticated clients so TURN credentials stay
 * server-side (and can later be swapped for short-lived, per-user tokens
 * without touching the client).
 */
export const callsRouter = Router();

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function buildIceServers(): IceServer[] {
  const servers: IceServer[] = [];

  const stun = splitUrls(env.STUN_URLS);
  if (stun.length) servers.push({ urls: stun });

  const turn = splitUrls(env.TURN_URLS);
  if (turn.length) {
    servers.push({
      urls: turn,
      ...(env.TURN_USERNAME ? { username: env.TURN_USERNAME } : {}),
      ...(env.TURN_CREDENTIAL ? { credential: env.TURN_CREDENTIAL } : {}),
    });
  }

  return servers;
}

function splitUrls(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

callsRouter.get(
  "/ice-servers",
  requireAuth,
  asyncHandler(async (_req, res) => {
    sendData(res, { iceServers: buildIceServers() });
  })
);
