import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";

import path from "node:path";

import { fromStoredPath, outputDir, scriptPath, toStoredPath, uploadsDir } from "./paths.ts";

// These names used to be spelled inside a path.resolve at each call site, where a typo showed up
// as a synthesis job failing minutes later. They are strings now, so check them here. Every script
// the server spawns belongs in this list — hn-top10.mjs was missed by the original conversion and
// kept walking up from import.meta.url, which resolves to nothing in a compiled binary.
const SPAWNED = [
  "synthesize.py",
  "synthesize_bg_tts_mlx.py",
  "synthesize_mms_tts.py",
  "synthesize_kugel_tts.py",
  "synthesize_say_tts.py",
  "synthesize_pocket_tts.py",
  "embed_bge_m3.py",
  "page_geometry.py",
  "models.py",
  "hn-top10.mjs",
];

describe("scriptPath", () => {
  it.each(SPAWNED)("resolves %s to a file that exists", async (name) => {
    await expect(access(scriptPath(name))).resolves.toBeUndefined();
  });

  it("is absolute, so a worker's working directory cannot change what gets run", () => {
    expect(scriptPath("synthesize.py").startsWith("/")).toBe(true);
  });
});

describe("stored paths", () => {
  it("keeps only the part of a path that is not this machine", () => {
    const audio = path.join(outputDir, "b-1", "ch000.m4a");
    expect(toStoredPath(audio)).toBe(path.join("output", "b-1", "ch000.m4a"));
    expect(fromStoredPath(toStoredPath(audio))).toBe(audio);
  });

  it("round-trips an upload the same way", () => {
    const pdf = path.join(uploadsDir, "b-1", "book.pdf");
    expect(toStoredPath(pdf)).toBe(path.join("uploads", "b-1", "book.pdf"));
    expect(fromStoredPath(toStoredPath(pdf))).toBe(pdf);
  });

  // The rows written before this existed, and any file a user points at from outside the library
  it("leaves a path outside the data dir absolute, and resolves it to itself", () => {
    expect(toStoredPath("/elsewhere/on/disk/book.pdf")).toBe("/elsewhere/on/disk/book.pdf");
    expect(fromStoredPath("/elsewhere/on/disk/book.pdf")).toBe("/elsewhere/on/disk/book.pdf");
  });

  // The whole point: the same row read on a machine whose data dir is somewhere else
  it("is worth nothing unless the answer follows DATA_DIR", () => {
    const stored = toStoredPath(path.join(outputDir, "b-1", "ch000.m4a"));
    expect(stored.startsWith("/")).toBe(false);
    expect(path.resolve("/data", stored)).toBe("/data/output/b-1/ch000.m4a");
  });
});
