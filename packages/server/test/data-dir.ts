import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../src/env.ts";
import { invalidateCloudDiscovery } from "../src/lib/cloud-models.ts";

type Listings = Record<string, { at: number; ids: string[]; meta?: Record<string, unknown> }>;

// Points the on-disk caches at a directory of the test's own, so a test states what it expects to
// find there rather than inheriting whatever the checkout's ./data holds. Returns the restore, to
// be called in a finally or afterEach.
export function useTempDataDir(listings?: Listings): () => void {
  const previous = env.DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libratory-test-data-"));
  if (listings) fs.writeFileSync(path.join(dir, "provider-listings.json"), JSON.stringify(listings));
  env.DATA_DIR = dir;
  // The listings are read through a memo, so a file written after the first read would otherwise
  // never be seen.
  invalidateCloudDiscovery();
  return () => {
    env.DATA_DIR = previous;
    invalidateCloudDiscovery();
  };
}
