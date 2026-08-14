import "express";
import type { Session, User } from "../../db/schema";

// Attach the resolved session to the request in `requireAuth`.
declare global {
  namespace Express {
    interface Request {
      auth?: { user: User; session: Session };
    }
  }
}
