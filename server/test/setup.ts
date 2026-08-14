import path from "node:path";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll } from "vitest";
import { closeDb, getDb, initDb } from "../src/db";

/**
 * Test bootstrap. NODE_ENV/DB_CLIENT are set via vitest.config `env` so the DB
 * layer selects PGlite before any module loads. Here we init the in-memory
 * database and apply the generated migrations — proving migrations run cleanly.
 */
beforeAll(async () => {
  await initDb();
  await migrate(getDb() as never, {
    migrationsFolder: path.resolve(__dirname, "../drizzle"),
  });
});

afterAll(async () => {
  await closeDb();
});
