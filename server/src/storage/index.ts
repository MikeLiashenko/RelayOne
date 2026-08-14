import { env } from "../config/env";
import { LocalStorageProvider } from "./localStorageProvider";
import type { StorageProvider } from "./storageProvider";

let provider: StorageProvider | null = null;

/** Returns the configured storage provider (singleton). */
export function getStorage(): StorageProvider {
  if (!provider) {
    switch (env.STORAGE_PROVIDER) {
      case "local":
      default:
        provider = new LocalStorageProvider();
    }
  }
  return provider;
}

export type { StorageProvider, UploadTarget } from "./storageProvider";
