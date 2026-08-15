import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { storageObjects } from "../db/schema";
import { env } from "../config/env";
import type { StorageProvider, StoredObject, UploadTarget } from "./storageProvider";

/**
 * Durable storage provider that keeps object bytes in Postgres (table
 * `storage_objects`). Unlike the local-disk provider, this survives restarts
 * and redeploys — important on hosts with an ephemeral filesystem (e.g.
 * Render's free tier), so avatars and attachments don't vanish.
 *
 * Uploads still flow through the app's own `/uploads/:key` endpoint (see the
 * uploads router); only the backing store differs. Bytes are held as base64
 * text for portability across the postgres.js and PGlite drivers. This is
 * intended for small files (avatars); large media belongs on real object
 * storage (S3/R2), which this same interface supports.
 */
export class DbStorageProvider implements StorageProvider {
  async createUploadTarget(params: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    const url = this.getPublicUrl(params.key);
    return {
      storageKey: params.key,
      uploadUrl: url,
      method: "PUT",
      headers: { "content-type": params.contentType },
      publicUrl: url,
    };
  }

  getPublicUrl(key: string): string {
    return `${env.STORAGE_PUBLIC_BASE_URL}/${key}`;
  }

  async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const encoded = data.toString("base64");
    await getDb()
      .insert(storageObjects)
      .values({ key, contentType, data: encoded, sizeBytes: data.length })
      .onConflictDoUpdate({
        target: storageObjects.key,
        set: { contentType, data: encoded, sizeBytes: data.length },
      });
  }

  async getObject(key: string): Promise<StoredObject | null> {
    const [row] = await getDb()
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.key, key))
      .limit(1);
    if (!row) return null;
    return { data: Buffer.from(row.data, "base64"), contentType: row.contentType };
  }

  async deleteObject(key: string): Promise<void> {
    await getDb().delete(storageObjects).where(eq(storageObjects.key, key));
  }
}
