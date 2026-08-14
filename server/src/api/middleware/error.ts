import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { isProd } from "../../config/env";
import { AppError } from "../../shared/errors";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res
    .status(404)
    .json({ error: { code: "not_found", message: "Route not found." } });
};

/**
 * Terminal error middleware. Produces the consistent error envelope
 * `{ error: { code, message, details? } }` and never leaks stack traces or
 * database internals to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "validation_error",
        message: "Invalid request.",
        details: err.flatten(),
      },
    });
    return;
  }

  if (!isProd) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(500).json({
    error: { code: "internal_error", message: "Something went wrong." },
  });
};
