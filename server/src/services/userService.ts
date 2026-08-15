import { and, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
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

  /** Of the given ids, which hide their last-seen / online status. */
  async lastSeenHiddenSet(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await getDb()
      .select({ id: users.id, p: users.privacyLastSeen })
      .from(users)
      .where(inArray(users.id, ids));
    return new Set(rows.filter((r) => r.p === "nobody").map((r) => r.id));
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
      privacy?: {
        messages?: "everyone" | "contacts" | "nobody";
        lastSeen?: "everyone" | "nobody";
        avatar?: "everyone" | "contacts" | "nobody";
      };
    }
  ): Promise<User> {
    if (patch.username) {
      const existing = await this.getByUsername(patch.username);
      if (existing && existing.id !== userId) {
        throw AppError.conflict("That username is already taken.");
      }
    }
    // Build only the columns present (privacy is a nested DTO → flat columns).
    const set: Record<string, unknown> = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.username !== undefined) set.username = patch.username;
    if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.privacy?.messages) set.privacyMessages = patch.privacy.messages;
    if (patch.privacy?.lastSeen) set.privacyLastSeen = patch.privacy.lastSeen;
    if (patch.privacy?.avatar) set.privacyAvatar = patch.privacy.avatar;

    const [updated] = await getDb()
      .update(users)
      .set(set)
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw AppError.notFound("User not found.");
    return updated;
  },

  isUsernameAvailable,
};
