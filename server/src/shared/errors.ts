/**
 * Typed application errors. Route handlers throw these; the error middleware
 * translates them into consistent JSON responses. Never leak stack traces or
 * database internals to the client.
 */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "invalid_code"
  | "expired_code"
  | "too_many_attempts"
  | "internal_error";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(message: string, details?: unknown) {
    return new AppError(400, "validation_error", message, details);
  }
  static unauthorized(message = "Authentication required.") {
    return new AppError(401, "unauthorized", message);
  }
  static forbidden(message = "You don't have access to this resource.") {
    return new AppError(403, "forbidden", message);
  }
  static notFound(message = "Not found.") {
    return new AppError(404, "not_found", message);
  }
  static conflict(message: string) {
    return new AppError(409, "conflict", message);
  }
  static rateLimited(message = "Too many requests. Try again later.") {
    return new AppError(429, "rate_limited", message);
  }
  static internal(message = "Something went wrong.") {
    return new AppError(500, "internal_error", message);
  }
}
