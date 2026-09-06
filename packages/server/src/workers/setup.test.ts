import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb, ensureGraphileTables, insertJob } from "../../test/setup.ts";

const { mockRun, runCalls } = vi.hoisted(() => {
  const runCalls: { concurrency: number }[] = [];
  return {
    runCalls,
    mockRun: vi.fn(async (opts: { concurrency: number }) => {
      runCalls.push({ concurrency: opts.concurrency });
      // Keeps the one graphile behaviour this module has to respect: a second stop throws rather
      // than being ignored, which is what makes a stopped runner left in the map so damaging.
      return new (class {
        stopped = false;
        async stop() {
          if (this.stopped) throw new Error("Runner is already stopped");
          this.stopped = true;
        }
      })();
    }),
  };
});

vi.mock("graphile-worker", () => ({
  run: mockRun,
  quickAddJob: vi.fn(async () => {}),
  makeWorkerUtils: vi.fn(async () => ({ release: async () => {}, addJob: async () => {} })),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { env } from "../env.ts";
import { applyPoolConcurrency, startWorker } from "./setup.ts";
import { poolByName, poolConcurrency } from "./pools.ts";

describe("applyPoolConcurrency", () => {
  beforeAll(async () => {
    await ensureGraphileTables(getDb());
    await startWorker();
  });

  beforeEach(async () => {
    await resetDb(getDb());
    env.WORKER_CONCURRENCY_PREP = undefined;
    mockRun.mockClear();
    runCalls.length = 0;
  });

  it("refuses while the pool has a job in flight, and leaves the setting alone", async () => {
    await insertJob(getDb(), "normalize", { chapterId: "c1" }, { lockedAt: new Date() });

    await expect(applyPoolConcurrency("prep", 4)).rejects.toThrow(/1 job running/);
    expect(env.WORKER_CONCURRENCY_PREP).toBeUndefined();
    expect(runCalls).toEqual([]);
  });

  it("rejects a number past the pool's ceiling", async () => {
    await expect(applyPoolConcurrency("index", 5)).rejects.toThrow(/between 1 and 2/);
  });

  it("persists only after the pool is running on the new number", async () => {
    await applyPoolConcurrency("prep", 4);
    expect(runCalls).toEqual([{ concurrency: 4 }]);
    expect(poolConcurrency(poolByName("prep"))).toBe(4);
  });

  it("puts the pool back on the working number when the new runner fails to start", async () => {
    mockRun.mockRejectedValueOnce(new Error("connection refused"));

    await expect(applyPoolConcurrency("prep", 4)).rejects.toThrow("connection refused");
    // The old concurrency is running again, and .env was never told about the failed number
    expect(runCalls).toEqual([{ concurrency: 2 }]);
    expect(env.WORKER_CONCURRENCY_PREP).toBeUndefined();

    // and the pool is still replaceable — a stopped runner left in the map would throw here
    await expect(applyPoolConcurrency("prep", 3)).resolves.toBeUndefined();
  });

  it("serializes concurrent changes so no orphan runner is left claiming jobs", async () => {
    await Promise.all([applyPoolConcurrency("prep", 3), applyPoolConcurrency("prep", 4)]);

    // Two changes, two runners started, and each replaced runner stopped exactly once —
    // a lost update here would leave a runner nothing can stop
    expect(runCalls).toEqual([{ concurrency: 3 }, { concurrency: 4 }]);
    expect(poolConcurrency(poolByName("prep"))).toBe(4);
  });
});
