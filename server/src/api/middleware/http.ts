import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wrap an async handler so thrown/rejected errors reach the error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Consistent success envelope: `{ data: ... }`. */
export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data });
}
