import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.ts", () => ({ db: {} }));

import { moveAll } from "./structure-apply.ts";

describe("moveAll", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("swaps two chapters' files and replaces stale leftovers at the destination", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moves-"));
    await writeFile(path.join(dir, "ch000.m4a"), "zero");
    await writeFile(path.join(dir, "ch001.m4a"), "one");
    await mkdir(path.join(dir, "chunks", "ch000"), { recursive: true });
    await writeFile(path.join(dir, "chunks", "ch000", "a.wav"), "zero-chunk");
    await mkdir(path.join(dir, "chunks", "ch001"), { recursive: true });
    await writeFile(path.join(dir, "chunks", "ch001", "stale.wav"), "stale");

    await moveAll([
      { from: path.join(dir, "ch000.m4a"), to: path.join(dir, "ch001.m4a") },
      { from: path.join(dir, "ch001.m4a"), to: path.join(dir, "ch000.m4a") },
      { from: path.join(dir, "ch000.sync.json"), to: path.join(dir, "ch001.sync.json") },
      { from: path.join(dir, "chunks", "ch000"), to: path.join(dir, "chunks", "ch001") },
    ]);

    expect(await readFile(path.join(dir, "ch000.m4a"), "utf8")).toBe("one");
    expect(await readFile(path.join(dir, "ch001.m4a"), "utf8")).toBe("zero");
    expect(await readFile(path.join(dir, "chunks", "ch001", "a.wav"), "utf8")).toBe("zero-chunk");
    await expect(stat(path.join(dir, "chunks", "ch001", "stale.wav"))).rejects.toThrow();
    await expect(stat(path.join(dir, "chunks", "ch000"))).rejects.toThrow();
  });

  it("puts everything back and throws when a move fails", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moves-"));
    await writeFile(path.join(dir, "ch000.m4a"), "zero");
    await writeFile(path.join(dir, "ch001.m4a"), "one");

    await expect(
      moveAll([
        { from: path.join(dir, "ch000.m4a"), to: path.join(dir, "ch002.m4a") },
        { from: path.join(dir, "ch001.m4a"), to: path.join(dir, "nowhere", "deep", "ch003.m4a") },
      ]),
    ).rejects.toThrow(/Could not move chapter files/);

    expect(await readFile(path.join(dir, "ch000.m4a"), "utf8")).toBe("zero");
    expect(await readFile(path.join(dir, "ch001.m4a"), "utf8")).toBe("one");
    await expect(stat(path.join(dir, "ch002.m4a"))).rejects.toThrow();
  });
});

describe("moveAll rollback", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("undoes a settled swap without losing either file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moves-"));
    await writeFile(path.join(dir, "a"), "A");
    await writeFile(path.join(dir, "b"), "B");
    await writeFile(path.join(dir, "c"), "C");

    const staged = await moveAll([
      { from: path.join(dir, "a"), to: path.join(dir, "b") },
      { from: path.join(dir, "b"), to: path.join(dir, "a") },
      { from: path.join(dir, "c"), to: path.join(dir, "d") },
    ]);
    expect(await readFile(path.join(dir, "a"), "utf8")).toBe("B");
    await staged.rollback();

    expect(await readFile(path.join(dir, "a"), "utf8")).toBe("A");
    expect(await readFile(path.join(dir, "b"), "utf8")).toBe("B");
    expect(await readFile(path.join(dir, "c"), "utf8")).toBe("C");
    await expect(stat(path.join(dir, "d"))).rejects.toThrow();
  });

  it("restores a settled swap when a later move in the same pass fails", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "moves-"));
    await writeFile(path.join(dir, "a"), "A");
    await writeFile(path.join(dir, "b"), "B");
    await writeFile(path.join(dir, "c"), "C");

    await expect(
      moveAll([
        { from: path.join(dir, "a"), to: path.join(dir, "b") },
        { from: path.join(dir, "b"), to: path.join(dir, "a") },
        { from: path.join(dir, "c"), to: path.join(dir, "missing", "c") },
      ]),
    ).rejects.toThrow(/Could not move chapter files/);

    expect(await readFile(path.join(dir, "a"), "utf8")).toBe("A");
    expect(await readFile(path.join(dir, "b"), "utf8")).toBe("B");
    expect(await readFile(path.join(dir, "c"), "utf8")).toBe("C");
  });
});
