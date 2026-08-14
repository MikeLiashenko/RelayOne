/**
 * Object-storage abstraction. Large files (images, video, documents, voice)
 * live here — never in Postgres. Swapping the local provider for S3/GCS/R2
 * later means implementing this interface once; the messaging code is unaware
 * of the backing store.
 */

export interface UploadTarget {
  storageKey: string;
  /** Where the client uploads the bytes (a presigned URL, or a local endpoint). */
  uploadUrl: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
  /** Where the object is publicly readable once uploaded. */
  publicUrl: string;
}

export interface StoredObject {
  data: Buffer;
  contentType: string;
}

export interface StorageProvider {
  /** Produce an upload destination for a given key + content type. */
  createUploadTarget(params: {
    key: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<UploadTarget>;

  getPublicUrl(key: string): string;

  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
}
