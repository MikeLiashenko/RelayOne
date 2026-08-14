import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { env } from "../config/env";
import * as schema from "./schema";

/**
 * Database access layer.
 *
 * Production/dev-server use the `postgres` (postgres.js) driver against a real
 * PostgreSQL instance. Tests set `DB_CLIENT=pglite` to run against an
 * in-process WASM Postgres — no external server required. Both expose the same
 * Drizzle query API, so the rest of the app is driver-agnostic.
 */
export type Database = PostgresJsDatabase<typeof schema>;

let _db: Database | null = null;
let _close: (() => Promise<void>) | null = null;
// Raw PGlite client, exposed only in test mode so the harness can run migrations.
let _pglite: unknown = null;

export async function initDb(): Promise<Database> {
  if (_db) return _db;

  if (env.DB_CLIENT === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    // Tests always run in-memory; a local dev run may persist to a directory.
    const dataDir = env.NODE_ENV === "test" ? undefined : env.PGLITE_DATA_DIR;
    const client = dataDir ? new PGlite(dataDir) : new PGlite();
    _pglite = client;
    _db = drizzle(client, { schema, casing: "snake_case" }) as unknown as Database;
    _close = async () => {
      await client.close();
    };
  } else {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(env.DATABASE_URL, { max: 10 });
    _db = drizzle(client, { schema, casing: "snake_case" });
    _close = async () => {
      await client.end({ timeout: 5 });
    };
  }

  return _db;
}

export function getDb(): Database {
  if (!_db) {
    throw new Error("Database not initialised — call initDb() during startup.");
  }
  return _db;
}

/** Test-only: the raw PGlite client, used to apply migrations in setup. */
export function getPgliteClient(): unknown {
  return _pglite;
}

export async function closeDb(): Promise<void> {
  if (_close) await _close();
  _db = null;
  _close = null;
  _pglite = null;
}

export { schema };
