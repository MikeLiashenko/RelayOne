import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "../config/env";

/**
 * Applies generated SQL migrations to the Postgres instance at DATABASE_URL.
 * Run after `npm run db:generate`. Safe to run repeatedly — Drizzle tracks
 * which migrations have already been applied.
 */
async function main() {
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await client.end();
  // eslint-disable-next-line no-console
  console.log("✓ Migrations applied to", env.DATABASE_URL.replace(/:\/\/.*@/, "://***@"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Migration failed:", err);
  process.exit(1);
});
