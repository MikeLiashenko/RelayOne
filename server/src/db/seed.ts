import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { env } from "../config/env";
import { chatService } from "../services/chatService";
import { messageService } from "../services/messageService";
import { closeDb, getDb, initDb } from "./index";
import { users, type User } from "./schema";

/**
 * Development-only seed. Creates a handful of CLEARLY MARKED test users and
 * conversations so the app has something to show locally. Refuses to run in
 * production and is idempotent (safe to run repeatedly).
 */
async function ensureUser(input: {
  username: string;
  displayName: string;
  email?: string;
  phone?: string;
}): Promise<User> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, input.username.toLowerCase()))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({
      username: input.username,
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
    })
    .returning();
  return created!;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.error("Refusing to seed a production database.");
    process.exit(1);
  }

  await initDb();

  const ada = await ensureUser({
    username: "relay_ada",
    displayName: "Ada — RelayOne test",
    email: "ada@relayone.test",
  });
  const grace = await ensureUser({
    username: "relay_grace",
    displayName: "Grace — RelayOne test",
    email: "grace@relayone.test",
  });
  const alan = await ensureUser({
    username: "relay_alan",
    displayName: "Alan — RelayOne test",
    phone: "+10000000003",
  });

  // Direct chat (dedupes on re-run).
  const direct = await chatService.createChat({
    creatorId: ada.id,
    type: "direct",
    memberIds: [grace.id],
  });
  if ((await messageService.list(direct.id, ada.id, { limit: 1 })).length === 0) {
    await messageService.send(direct.id, ada.id, {
      content: "Hey Grace — this is seeded RelayOne test data.",
    });
    await messageService.send(direct.id, grace.id, {
      content: "Got it — clearly marked as a test account.",
    });
  }

  // Group chat (create only if the seeded one doesn't already exist).
  const existingChats = await chatService.listForUser(ada.id);
  const hasGroup = existingChats.some(
    (c) => c.type === "group" && c.title === "RelayOne — test group"
  );
  if (!hasGroup) {
    const group = await chatService.createChat({
      creatorId: ada.id,
      type: "group",
      memberIds: [grace.id, alan.id],
      title: "RelayOne — test group",
    });
    await messageService.send(group.id, ada.id, {
      content: "Welcome to the seeded RelayOne test group.",
    });
  }

  // eslint-disable-next-line no-console
  console.log("✓ Seed complete: 3 test users, 1 direct chat, 1 group chat.");
  await closeDb();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", err);
  process.exit(1);
});
