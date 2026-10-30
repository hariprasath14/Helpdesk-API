import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../../config/index.js';

/** How a stored file is handed to the browser: streamed by the API, or a short-lived link (s3). */
export type StoredFile = { stream: Readable; size: number } | { redirectTo: string };

/**
 * The only way feature code stores files. Which service is used is a setting (STORAGE_DRIVER).
 * Keys are made by the app ("<workspace id>/<file id>", "inbound/<id>"), never from file names
 * people send.
 */
export interface FileStorage {
  /** Saves the stream under `key`; refuses (and removes the partial file) past `maxBytes`. */
  put(key: string, content: Readable, maxBytes: number): Promise<{ size: number }>;
  get(key: string): Promise<StoredFile>;
  remove(key: string): Promise<void>;
}

/** The file was bigger than allowed; nothing is kept. */
export class FileTooLargeError extends Error {
  constructor() {
    super('File too large');
    this.name = 'FileTooLargeError';
  }
}

// "<workspace id>/<file id>", or "inbound/<id>" for a received email waiting for its job (F14).
const KEY = /^([0-9a-f-]{36}|inbound)\/[0-9a-f-]{36}$/;

/** Local disk, under STORAGE_LOCAL_DIR (git-ignored). For development and tests. */
function localStorage(config: Config): FileStorage {
  const root = resolve(config.STORAGE_LOCAL_DIR);
  const pathOf = (key: string) => {
    if (!KEY.test(key)) throw new Error('Invalid storage key');
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error('Invalid storage key');
    return path;
  };
  return {
    async put(key, content, maxBytes) {
      const path = pathOf(key);
      // The folder and file names come from pathOf(), checked app-made keys, not user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await mkdir(dirname(path), { recursive: true });
      let size = 0;
      content.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) content.destroy(new FileTooLargeError());
      });
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await pipeline(content, createWriteStream(path));
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      return { size };
    },
    async get(key) {
      const path = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const { size } = await stat(path);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return { stream: createReadStream(path), size };
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

/** Picks the adapter from STORAGE_DRIVER. Only local exists until S3 is added at Step 0b. */
export function createFileStorage(config: Config): FileStorage {
  return localStorage(config);
}
