import { and, eq, ilike, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { users, type User } from "../db/schema";
import { AppError } from "../shared/errors";
import { isUsernameAvailable } from "../auth/authService";

/** User read/update operations. */
export const userService = {
  async getById(id: string): Promise<User | undefined> {
    const [u] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    return u;
  },

  async getByUsername(username: string): Promise<User | undefined> {
    const [u] = await getDb()
      .select()
      .from(users)
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
      .limit(1);
    return u;
  },

  async requireById(id: string): Promise<User> {
    const u = await this.getById(id);
    if (!u) throw AppError.notFound("User not found.");
    return u;
  },

  /** Find users by username or display name (excludes the caller). */
  async search(query: string, excludeUserId: string, limit = 12): Promise<User[]> {
    // Escape LIKE wildcards in user input so they're treated literally.
    const term = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    return getDb()
      .select()
      .from(users)
      .where(
        and(
          ne(users.id, excludeUserId),
          or(ilike(users.username, term), ilike(users.displayName, term))
        )
      )
      .limit(limit);
  },

  async updateProfile(
    userId: string,
    patch: {
      displayName?: string;
      username?: string;
      avatarUrl?: string | null;
      bio?: string | null;
    }
  ): Promise<User> {
    if (patch.username) {
      const existing = await this.getByUsername(patch.username);
      if (existing && existing.id !== userId) {
        throw AppError.conflict("That username is already taken.");
      }
    }
    const [updated] = await getDb()
      .update(users)
      .set(patch)
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw AppError.notFound("User not found.");
    return updated;
  },

  isUsernameAvailable,
};
