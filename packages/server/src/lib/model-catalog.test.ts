import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "../env.ts";
import { extract, readDisk, writeDisk } from "./model-catalog.ts";

// The write and the read each used to run their own shape — the cache persisted the extracted map
// and read it back through the extractor that expects the provider's payload — so a second run
// kept every label and lost every context window. A missing context window is not cosmetic: the
// guards in workers/book-note.ts and workers/digest.ts use it to decide whether a book fits in
// one call, and workers would start refusing books the model can take.
describe("model catalog cache", () => {
  let dir: string;
  let previous: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libratory-catalog-"));
    previous = env.DATA_DIR;
    env.DATA_DIR = dir;
  });

  afterEach(() => {
    env.DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const payload = {
    deepseek: {
      models: {
        "deepseek-v4-pro": {
          name: "DeepSeek V4 Pro",
          limit: { context: 1_000_000 },
          tool_call: true,
          structured_output: true,
        },
      },
    },
  };

  it("recovers exactly what it persisted", () => {
    writeDisk(payload);
    expect(readDisk()?.catalog).toEqual(extract(payload));
  });

  it("keeps the context window across the round trip", () => {
    writeDisk(payload);
    const entry = readDisk()?.catalog.get("deepseek")?.get("deepseek-v4-pro");
    expect(entry).toEqual({
      label: "DeepSeek V4 Pro",
      contextTokens: 1_000_000,
      supportsTools: true,
      supportsJsonFormat: true,
      supportsTemperature: undefined,
    });
  });

  it("treats an unreadable or truncated cache as absent rather than throwing", () => {
    fs.writeFileSync(path.join(dir, "model-catalog.json"), "{ not json");
    expect(readDisk()).toBeNull();
  });
});
