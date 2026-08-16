import cors from "cors";
import express, { type Express } from "express";
import { env } from "../config/env";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { attachmentsRouter } from "./routes/attachments.routes";
import { authRouter } from "./routes/auth.routes";
import { callsRouter } from "./routes/calls.routes";
import { chatsRouter } from "./routes/chats.routes";
import { linkRouter } from "./routes/link.routes";
import { messagesRouter } from "./routes/messages.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { pollsRouter } from "./routes/polls.routes";
import { profilesRouter } from "./routes/profiles.routes";
import { pushRouter } from "./routes/push.routes";
import { scheduledRouter } from "./routes/scheduled.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { uploadsRouter } from "./routes/uploads.routes";
import { usersRouter } from "./routes/users.routes";

/**
 * Assembles the Express application. Kept free of side effects (no listen, no
 * DB init) so tests can mount it directly with supertest.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ data: { status: "ok" } });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/profiles", profilesRouter);
  app.use("/api/chats", chatsRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/polls", pollsRouter);
  app.use("/api/scheduled", scheduledRouter);
  app.use("/api/attachments", attachmentsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/calls", callsRouter);
  app.use("/api/link-preview", linkRouter);

  // Local object-storage transport (dev). Not mounted under /api.
  app.use("/uploads", uploadsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
