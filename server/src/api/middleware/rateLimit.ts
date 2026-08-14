import rateLimit from "express-rate-limit";
import { env, isTest } from "../../config/env";

/**
 * Rate limiter for authentication / verification endpoints — a baseline guard
 * against brute-forcing codes and abusing code issuance. Disabled under tests.
 * (In-memory: fine for a single instance; use a shared store when scaling out.)
 */
export const authLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60_000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please try again later.",
      },
    });
  },
});
