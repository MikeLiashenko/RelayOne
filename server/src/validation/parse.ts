import type { z, ZodTypeAny } from "zod";
import { AppError } from "../shared/errors";

/**
 * Validate `data` against `schema`, returning typed output or throwing a
 * consistent 400 AppError. Used by route handlers so every endpoint validates
 * its input the same way.
 */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.validation("Invalid request.", result.error.flatten());
  }
  return result.data;
}
