import http from "node:http";
import { createApp } from "./api";
import { env } from "./config/env";
import { closeDb, getDb, initDb } from "./db";
import { attachRealtime } from "./realtime/gateway";

/**
 * Composition root: initialise the database, build the HTTP app, attach the
 * realtime WebSocket gateway to the same server, and listen.
 */
async function main(): Promise<void> {
  await initDb();

  // Apply migrations on boot (idempotent — Drizzle tracks what's applied). Works
  // for both the in-process PGlite dev DB and a real Postgres (e.g. on Render).
  // Resolve relative to the working dir (server/) so it works from source (tsx)
  // and from the compiled build (dist/src/server.js).
  {
    const path = await import("node:path");
    const migrationsFolder = path.resolve(process.cwd(), "drizzle");
    if (env.DB_CLIENT === "pglite") {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(getDb() as never, { migrationsFolder });
    } else {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(getDb() as never, { migrationsFolder });
    }
    // eslint-disable-next-line no-console
    console.log("✓ Database migrations applied.");
  }

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`RelayOne API listening on http://localhost:${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`RelayOne realtime on ws://localhost:${env.PORT}/ws`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
