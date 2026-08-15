import "dotenv/config";
import { z } from "zod";

/**
 * Central, validated configuration. Nothing else in the app reads
 * `process.env` directly — import `env` from here instead. Invalid config
 * fails fast at startup rather than surfacing as a confusing runtime error.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://relayone:relayone@localhost:5432/relayone"),

  CORS_ORIGIN: z.string().default("http://localhost:4321"),

  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  VERIFICATION_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  STORAGE_PROVIDER: z.enum(["local", "db"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./var/uploads"),
  // Public base for uploaded files. If unset, derive it from the platform's
  // external URL (Render injects RENDER_EXTERNAL_URL automatically) so avatars
  // and attachments get a reachable https:// address without extra config.
  // Falls back to the local dev server otherwise.
  STORAGE_PUBLIC_BASE_URL: z
    .string()
    .optional()
    .transform(
      (v) =>
        (v && v.trim()) ||
        (process.env.RENDER_EXTERNAL_URL
          ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, "")}/uploads`
          : "http://localhost:4000/uploads")
    ),

  // RelayOne Calls — WebRTC ICE configuration. STUN is enough for local dev;
  // add a TURN server (comma-separated URLs + credentials) for NAT traversal
  // in real networks. All optional; empty TURN simply isn't advertised.
  STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  // Web Push (VAPID). The public key is safe to ship to the browser; the
  // private key is a secret and enables push only when set (otherwise push is a
  // no-op, so local dev works without it). These must be a matching pair —
  // generate with `npx web-push generate-vapid-keys`.
  VAPID_PUBLIC_KEY: z
    .string()
    .default(
      "BCT_PZKRgNK_4aM_2EeWnESbzv4Dlg1qT0E_MZ5oORMQSnCVe9wry5Q-9kjCwTau_4PjoHliNaHhGJcDCHOcqG0"
    ),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:notify@relayone.app"),

  // Routes the DB layer at an in-process PGlite instance (tests always; and an
  // optional zero-setup local dev mode that needs no external Postgres).
  DB_CLIENT: z.enum(["postgres", "pglite"]).default("postgres"),
  // When DB_CLIENT=pglite: a directory to persist data. Empty = in-memory.
  PGLITE_DATA_DIR: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "Invalid environment configuration:\n",
    parsed.error.flatten().fieldErrors
  );
  throw new Error("Environment validation failed");
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDev = env.NODE_ENV === "development";

/** Whether verification codes may be surfaced to clients (never in prod). */
export const exposeDevCodes = !isProd;
