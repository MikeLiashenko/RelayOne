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

  // Zero-setup local dev: PGlite starts empty, so apply migrations on boot.
  // (Real Postgres uses the explicit `npm run db:migrate` step instead.)
  if (env.DB_CLIENT === "pglite") {
    const path = await import("node:path");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(getDb() as never, {
      migrationsFolder: path.resolve(__dirname, "../drizzle"),
    });
    // eslint-disable-next-line no-console
    console.log("✓ PGlite migrations applied (local dev mode).");
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
