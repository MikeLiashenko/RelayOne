import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Route the DB layer at in-process PGlite so tests need no external server.
    // Set before any module loads config/env.
    env: {
      NODE_ENV: "test",
      DB_CLIENT: "pglite",
    },
    setupFiles: ["./test/setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Isolate each test file (its own PGlite instance).
    pool: "forks",
  },
});
