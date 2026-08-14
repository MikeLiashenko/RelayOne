import "dotenv/config";
import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * `db:generate` produces SQL migrations from the schema and needs no live
 * database. `db:push` / `db:migrate` require DATABASE_URL to point at a
 * running Postgres instance.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://relayone:relayone@localhost:5432/relayone",
  },
  casing: "snake_case",
  strict: true,
  verbose: true,
} satisfies Config;
