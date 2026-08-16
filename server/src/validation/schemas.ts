import { z } from "zod";

/**
 * Request validation schemas + normalization. Shared by the API layer and the
 * auth service so the rules live in exactly one place. Mirrors the frontend
 * validators so client and server agree.
 */

/* -- Primitives ------------------------------------------------------------ */

export const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/,
    "Username must be 3–20 characters: letters, numbers or underscores, starting with a letter."
  );

export const displayNameSchema = z.string().trim().min(1).max(50);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.");

export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => {
    const hasPlus = v.startsWith("+");
    return (hasPlus ? "+" : "") + v.replace(/[^\d]/g, "");
  })
  .refine((v) => /^\+?[1-9]\d{7,14}$/.test(v), "Enter a valid phone number.");

export const channelSchema = z.enum(["email", "phone"]);

/** A channel + its matching identifier, validated together. */
export const identifierSchema = z
  .object({ channel: channelSchema, identifier: z.string() })
  .superRefine((val, ctx) => {
    const result =
      val.channel === "email"
        ? emailSchema.safeParse(val.identifier)
        : phoneSchema.safeParse(val.identifier);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identifier"],
        message: result.error.issues[0]?.message ?? "Invalid identifier.",
      });
    }
  })
  .transform((val) => ({
    channel: val.channel,
    identifier:
      val.channel === "email"
        ? emailSchema.parse(val.identifier)
        : phoneSchema.parse(val.identifier),
  }));

export const deviceSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    platform: z.string().trim().max(60).optional(),
    pushToken: z.string().trim().max(512).optional(),
  })
  .optional();

/* -- Auth ------------------------------------------------------------------ */

export const startSchema = z.object({
  channel: channelSchema,
  identifier: z.string(),
});

export const verifySchema = z.object({
  verificationId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
  device: deviceSchema,
});

export const completeProfileSchema = z.object({
  registrationTicket: z.string().uuid(),
  displayName: displayNameSchema,
  username: usernameSchema,
  avatarUrl: z.string().url().max(2048).optional(),
  device: deviceSchema,
});

/* -- Users / profiles ------------------------------------------------------ */

export const usernameQuerySchema = z.object({ username: z.string() });

export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    username: usernameSchema.optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
    bio: z.string().trim().max(280).nullable().optional(),
    privacy: z
      .object({
        messages: z.enum(["everyone", "contacts", "nobody"]).optional(),
        lastSeen: z.enum(["everyone", "nobody"]).optional(),
        avatar: z.enum(["everyone", "contacts", "nobody"]).optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "No fields to update.");

/* -- Polls ----------------------------------------------------------------- */

export const createPollSchema = z
  .object({
    question: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
    allowsMultiple: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    isQuiz: z.boolean().default(false),
    correctIndex: z.number().int().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.isQuiz) {
      if (v.allowsMultiple) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowsMultiple"],
          message: "A quiz can't allow multiple answers.",
        });
      }
      if (v.correctIndex == null || v.correctIndex >= v.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctIndex"],
          message: "Select which answer is correct.",
        });
      }
    }
  });

export const votePollSchema = z.object({
  optionIds: z.array(z.string().uuid()).min(1).max(10),
});

/* -- Chats ----------------------------------------------------------------- */

export const createChatSchema = z
  .object({
    type: z.enum(["direct", "group", "channel"]),
    memberIds: z.array(z.string().uuid()).max(256).default([]),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "direct" && v.memberIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memberIds"],
        message: "A direct chat has exactly one other member.",
      });
    }
    if (v.type !== "direct" && !v.title) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: "A group or channel needs a name.",
      });
    }
  });

/* -- Spaces (communities) -------------------------------------------------- */

const spaceChannelKind = z.enum([
  "text",
  "forum",
  "announcement",
  "poll",
  "voice",
  "video",
]);

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

export const updateSpaceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    handle: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, "Handles use letters, numbers and hyphens.")
      .optional(),
    description: z.string().trim().max(280).nullable().optional(),
    avatarUrl: z.string().url().max(2048).nullable().optional(),
    bannerUrl: z.string().url().max(2048).nullable().optional(),
    visibility: z.enum(["public", "private"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "No fields to update.");

export const createSpaceChannelSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(8).optional(),
  kind: spaceChannelKind.default("text"),
  category: z.string().trim().max(40).optional(),
});

export const updateSpaceMemberSchema = z.object({
  role: z.enum(["admin", "moderator", "contributor", "member"]),
});

/* -- Messages -------------------------------------------------------------- */

export const sendMessageSchema = z
  .object({
    content: z.string().trim().max(8000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).optional(),
    replyToId: z.string().uuid().optional(),
    // Self-destruct: delete the message this many seconds after it's sent.
    ttlSeconds: z.number().int().min(1).max(604800).optional(),
  })
  .refine(
    (v) => (v.content && v.content.length > 0) || (v.attachmentIds?.length ?? 0) > 0,
    "A message needs text or at least one attachment."
  );

export const scheduleMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  sendAt: z.coerce.date(),
  ttlSeconds: z.number().int().min(1).max(604800).optional(),
  replyToId: z.string().uuid().optional(),
});

export const userSearchSchema = z.object({
  q: z.string().trim().min(1).max(80),
});

export const editMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(24),
});

export const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

/* -- Attachments ----------------------------------------------------------- */

export const createAttachmentSchema = z.object({
  kind: z.enum(["image", "video", "document", "voice"]),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  fileName: z.string().trim().max(255).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().int().positive().optional(),
});
