import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth } from "../../auth/middleware";
import { chatService } from "../../services/chatService";
import { messageService } from "../../services/messageService";
import { hub } from "../../realtime/hub";
import { parse } from "../../validation/parse";
import {
  createChatSchema,
  listMessagesSchema,
  sendMessageSchema,
} from "../../validation/schemas";
import { asyncHandler, sendData } from "../middleware/http";

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

const idParam = z.string().uuid();

/** List the caller's chats (with last message, unread count, presence). */
chatsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    sendData(res, await chatService.listSummariesForUser(user.id));
  })
);

const sharedQuery = z.object({
  type: z.enum(["media", "files", "links", "voice"]).default("media"),
});

/** Shared media/files/links/voice in a chat (per-chat "Shared" tabs). */
chatsRouter.get(
  "/:id/shared",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { type } = parse(sharedQuery, req.query);
    sendData(res, await messageService.listShared(id, user.id, type));
  })
);

/** Create a direct or group chat (dedupes existing direct chats). */
chatsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const input = parse(createChatSchema, req.body);
    const chat = await chatService.createChat({ creatorId: user.id, ...input });
    sendData(res, chat, 201);
  })
);

/** The caller's private Saved Messages chat (created on first access). */
chatsRouter.get(
  "/saved",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    sendData(res, await chatService.getOrCreateSaved(user.id));
  })
);

/** Fetch a chat (with member read + presence state) the caller belongs to. */
chatsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await chatService.getDetail(id, user.id));
  })
);

/** List pinned messages in a chat. */
chatsRouter.get(
  "/:id/pins",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    sendData(res, await messageService.listPinned(id, user.id));
  })
);

/** Paginated message history (chronological). */
chatsRouter.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const query = parse(listMessagesSchema, req.query);
    sendData(res, await messageService.list(id, user.id, query));
  })
);

/** Send a message to a chat. */
chatsRouter.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const body = parse(sendMessageSchema, req.body);
    const message = await messageService.send(id, user.id, body);
    sendData(res, message, 201);
  })
);

/** Mark the chat read up to a message (also emits a read receipt). */
chatsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { user } = getAuth(req);
    const id = parse(idParam, req.params.id);
    const { messageId } = parse(
      z.object({ messageId: z.string().uuid() }),
      req.body
    );
    await chatService.assertMember(id, user.id);
    await chatService.markRead(id, user.id, messageId);
    const members = await chatService.getMemberIds(id);
    hub.broadcastToUsers(members, {
      type: "read",
      chatId: id,
      userId: user.id,
      lastReadMessageId: messageId,
      at: new Date().toISOString(),
    });
    res.status(204).end();
  })
);
