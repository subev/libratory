import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, ensureGraphileTables, insertJob } from "../../test/setup.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { env } from "../env.ts";
import { POOL_META, poolByName, poolConcurrency, poolStatus, runningJobsByPool } from "./pools.ts";

describe("pool concurrency", () => {
  beforeEach(() => {
    for (const pool of POOL_META) env[pool.envVar] = undefined;
  });

  it("falls back to the pool default when nothing is configured", () => {
    expect(poolConcurrency(poolByName("extraction"))).toBe(1);
    expect(poolConcurrency(poolByName("translate"))).toBe(3);
  });

  it("clamps a configured value to the pool's ceiling", () => {
    env.WORKER_CONCURRENCY_EXTRACTION = 99;
    expect(poolConcurrency(poolByName("extraction"))).toBe(poolByName("extraction").max);
  });

  it("reports a caution only once the value passes the pool's soft limit", async () => {
    const caution = async (name: "extraction") => (await poolStatus()).find((p) => p.name === name)!.caution;
    expect(await caution("extraction")).toBeNull();
    env.WORKER_CONCURRENCY_EXTRACTION = 2;
    expect(await caution("extraction")).toBeTruthy();
  });
});

describe("running jobs by pool", () => {
  beforeAll(async () => {
    await ensureGraphileTables(getDb());
  });

  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("counts only locked jobs, against the pool that owns the task", async () => {
    await insertJob(getDb(), "extract", { bookId: "b1" }, { lockedAt: new Date() });
    await insertJob(getDb(), "propose", { bookId: "b2" }, { lockedAt: new Date() });
    await insertJob(getDb(), "synthesize", { chapterId: "c1" });

    const running = await runningJobsByPool();
    expect(running.extraction).toBe(2);
    expect(running.tts).toBe(0);
  });
});
