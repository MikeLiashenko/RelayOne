import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env";
import type { StorageProvider, StoredObject, UploadTarget } from "./storageProvider";

/**
 * Development storage provider that writes to the local filesystem. Uploads go
 * through the app's own `/uploads/:key` endpoint (see attachments router),
 * standing in for a presigned-URL flow. Not for production.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly base = path.resolve(env.STORAGE_LOCAL_DIR);

  private resolveKeyPath(key: string): string {
    const resolved = path.resolve(this.base, key);
    // Prevent path traversal outside the storage root.
    if (resolved !== this.base && !resolved.startsWith(this.base + path.sep)) {
      throw new Error("Invalid storage key");
    }
    return resolved;
  }

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
    const filePath = this.resolveKeyPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    await fs.writeFile(`${filePath}.meta`, contentType, "utf8");
  }

  async getObject(key: string): Promise<StoredObject | null> {
    try {
      const filePath = this.resolveKeyPath(key);
      const data = await fs.readFile(filePath);
      let contentType = "application/octet-stream";
      try {
        contentType = await fs.readFile(`${filePath}.meta`, "utf8");
      } catch {
        /* metadata is best-effort */
      }
      return { data, contentType };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      const filePath = this.resolveKeyPath(key);
      await fs.unlink(filePath);
      await fs.unlink(`${filePath}.meta`).catch(() => undefined);
    } catch {
      /* already gone */
    }
  }
}
