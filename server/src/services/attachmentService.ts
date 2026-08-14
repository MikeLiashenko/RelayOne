import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { attachments, type Attachment } from "../db/schema";
import { AppError } from "../shared/errors";
import { toPublicAttachment } from "../shared/serialize";
import type { PublicAttachment } from "../shared/types";
import { getStorage, type UploadTarget } from "../storage";

/**
 * Attachments: create a metadata row + an upload target, then serve bytes
 * through the storage provider. The DB stores only metadata; bytes live in
 * object storage.
 */
export const attachmentService = {
  async createUpload(
    uploaderId: string,
    input: {
      kind: "image" | "video" | "document" | "voice";
      mimeType: string;
      sizeBytes: number;
      fileName?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
    }
  ): Promise<{ attachment: PublicAttachment; upload: UploadTarget }> {
    const safeName = sanitizeName(input.fileName) ?? "file";
    const key = `attachments/${randomUUID()}/${safeName}`;

    const [row] = await getDb()
      .insert(attachments)
      .values({
        uploaderId,
        kind: input.kind,
        storageKey: key,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        fileName: input.fileName ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        durationSeconds: input.durationSeconds ?? null,
      })
      .returning();

    const upload = await getStorage().createUploadTarget({
      key,
      contentType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });

    return { attachment: toPublicAttachment(row!), upload };
  },

  async getByStorageKey(key: string): Promise<Attachment | undefined> {
    const [row] = await getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.storageKey, key))
      .limit(1);
    return row;
  },

  /** Throws unless `userId` uploaded the attachment at `key`. */
  async assertUploader(key: string, userId: string): Promise<Attachment> {
    const row = await this.getByStorageKey(key);
    if (!row) throw AppError.notFound("Attachment not found.");
    if (row.uploaderId !== userId) throw AppError.forbidden();
    return row;
  },
};

function sanitizeName(name?: string): string | undefined {
  if (!name) return undefined;
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || undefined;
}
