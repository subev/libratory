import path from "node:path";
import { mkdir } from "node:fs/promises";

import { env } from "../env.ts";

const DATA_DIR = env.DATA_DIR;

// Every Python worker is spawned by path, and those paths used to be found by walking up from
// whichever file did the spawning — which stops working the moment the server is not laid out
// like the repo. One setting instead of eight relative walks.
export function scriptPath(name: string): string {
  return path.resolve(env.SCRIPTS_DIR, name);
}

// Every file this app owns lives under DATA_DIR, so that prefix is the one part of a path the
// database has no business remembering: it moves with the checkout, and it is /data in the
// container. Storing it cost 2547 rows pointing at a directory that no longer existed the day this
// repo was renamed. `schema.ts` puts these on the path columns themselves, so nothing else has to
// know. A value outside DATA_DIR is kept absolute and resolves to itself, which is also what makes
// every row written before this keep working.
export function toStoredPath(absolute: string): string {
  const relative = path.relative(path.resolve(DATA_DIR), absolute);
  return relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative;
}

export function fromStoredPath(stored: string): string {
  return path.resolve(DATA_DIR, stored);
}

export const uploadsDir = path.resolve(DATA_DIR, "uploads");
export const tmpDir = path.resolve(DATA_DIR, "tmp");
export const outputDir = path.resolve(DATA_DIR, "output");
export const previewsDir = path.resolve(DATA_DIR, "previews");
export const pocketVoicesDir = path.resolve(DATA_DIR, "pocket-voices");

export async function ensureDataDirs() {
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(previewsDir, { recursive: true });
  await mkdir(pocketVoicesDir, { recursive: true });
}

export function bookOutputDir(bookId: string) {
  return path.join(outputDir, bookId);
}

export function bookTmpDir(bookId: string) {
  return path.join(tmpDir, bookId);
}
