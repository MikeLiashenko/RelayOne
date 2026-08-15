import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  chats,
  messages,
  pollOptions,
  pollVotes,
  polls,
  type Message,
  type Poll,
} from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicPoll } from "../shared/serialize";
import type { PublicMessage, PublicPoll } from "../shared/types";
import { hub } from "../realtime/hub";
import { chatService } from "./chatService";
import { messageService } from "./messageService";
import { notificationService } from "./notificationService";

/**
 * Polls (incl. quiz polls). A poll rides on a normal message (content is null)
 * so it flows through the existing message pipeline; vote state is kept in
 * `poll_options` / `poll_votes` and serialized per-viewer.
 *
 * Vote counts are broadcast to everyone via a compact `poll.update` event; each
 * client keeps its own `myVotes` (which it knows from its own action) and only
 * learns the quiz answer once it has voted (via its HTTP response) or when the
 * poll is closed (revealed in the broadcast).
 */
export const pollService = {
  async createPoll(
    chatId: string,
    authorId: string,
    input: {
      question: string;
      options: string[];
      allowsMultiple: boolean;
      anonymous: boolean;
      isQuiz: boolean;
      correctIndex?: number;
    }
  ): Promise<PublicMessage> {
    await chatService.assertMember(chatId, authorId);
    const db = getDb();

    const [message] = await db
      .insert(messages)
      .values({ chatId, senderId: authorId, content: null })
      .returning();

    const [poll] = await db
      .insert(polls)
      .values({
        messageId: message!.id,
        question: input.question,
        allowsMultiple: input.allowsMultiple,
        anonymous: input.anonymous,
        isQuiz: input.isQuiz,
      })
      .returning();

    const optRows = await db
      .insert(pollOptions)
      .values(input.options.map((text, i) => ({ pollId: poll!.id, text, position: i })))
      .returning();

    if (input.isQuiz && input.correctIndex != null && optRows[input.correctIndex]) {
      await db
        .update(polls)
        .set({ correctOptionId: optRows[input.correctIndex]!.id })
        .where(eq(polls.id, poll!.id));
    }

    await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

    const [full] = await messageService.hydrate([message!], authorId);
    const memberIds = await chatService.getMemberIds(chatId);
    hub.broadcastToUsers(memberIds, { type: "message.new", message: full! });
    await Promise.all(
      memberIds
        .filter((id) => id !== authorId)
        .map((id) =>
          notificationService.create(id, { type: "poll", chatId, messageId: message!.id })
        )
    );
    return full!;
  },

  async vote(pollId: string, userId: string, optionIds: string[]): Promise<PublicPoll> {
    const db = getDb();
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    if (!poll) throw AppError.notFound("Poll not found.");
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, poll.messageId))
      .limit(1);
    if (!message) throw AppError.notFound("Poll not found.");
    await chatService.assertMember(message.chatId, userId);
    if (poll.closedAt) throw AppError.validation("This poll is closed.");

    const opts = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId));
    const valid = new Set(opts.map((o) => o.id));
    const chosen = [...new Set(optionIds)].filter((id) => valid.has(id));
    if (chosen.length === 0) throw AppError.validation("Choose at least one option.");
    if (!poll.allowsMultiple && chosen.length > 1) {
      throw AppError.validation("This poll allows only one choice.");
    }

    // Replace this user's votes for the poll (idempotent re-voting).
    await db.delete(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
    await db.insert(pollVotes).values(chosen.map((optionId) => ({ pollId, optionId, userId })));

    return this.broadcastAndSerialize(poll, message, userId);
  },

  async close(pollId: string, userId: string): Promise<PublicPoll> {
    const db = getDb();
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    if (!poll) throw AppError.notFound("Poll not found.");
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, poll.messageId))
      .limit(1);
    if (!message) throw AppError.notFound("Poll not found.");
    if (message.senderId !== userId) {
      throw AppError.forbidden("Only the poll's author can close it.");
    }
    if (!poll.closedAt) {
      await db.update(polls).set({ closedAt: new Date() }).where(eq(polls.id, pollId));
    }
    const [fresh] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
    return this.broadcastAndSerialize(fresh!, message, userId);
  },

  /** Recompute counts, broadcast a compact update, and return the viewer's poll. */
  async broadcastAndSerialize(
    poll: Poll,
    message: Message,
    viewerId: string
  ): Promise<PublicPoll> {
    const db = getDb();
    const [opts, votes] = await Promise.all([
      db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)),
      db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id)),
    ]);
    const publicPoll = toPublicPoll(poll, opts, votes, viewerId);

    const memberIds = await chatService.getMemberIds(message.chatId);
    const voterSet = new Set(votes.map((v) => v.userId));
    const countByOpt = new Map<string, number>();
    for (const v of votes) countByOpt.set(v.optionId, (countByOpt.get(v.optionId) ?? 0) + 1);

    hub.broadcastToUsers(memberIds, {
      type: "poll.update",
      chatId: message.chatId,
      messageId: message.id,
      pollId: poll.id,
      totalVoters: voterSet.size,
      closed: poll.closedAt != null,
      options: opts.map((o) => ({ id: o.id, votes: countByOpt.get(o.id) ?? 0 })),
      // The quiz answer becomes public only when the poll is closed.
      correctOptionId: poll.closedAt != null ? poll.correctOptionId : undefined,
    });

    return publicPoll;
  },
};
