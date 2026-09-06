import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { POOL_NAMES, poolStatus } from "../workers/pools.ts";
import { applyPoolConcurrency } from "../workers/setup.ts";

export const workersRouter = router({
  pools: publicProcedure.query(() => poolStatus()),

  // The per-pool ceiling and the "nothing in flight" rule are enforced in applyPoolConcurrency,
  // which is also what the desktop app's own restarts go through.
  setConcurrency: publicProcedure
    .input(z.object({ pool: z.enum(POOL_NAMES), concurrency: z.number().int().min(1).max(16) }))
    .mutation(({ input }) => applyPoolConcurrency(input.pool, input.concurrency)),
});
