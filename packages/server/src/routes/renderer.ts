import { router, publicProcedure } from "../trpc.ts";
import { installRenderer, rendererReady } from "../lib/vivliostyle.ts";

// One download at a time: two @puppeteer/browsers installs unpacking into the same cache is how
// the half-finished directory that rendererInstalled has to defend against gets created.
let installing: Promise<void> | null = null;

export const rendererRouter = router({
  status: publicProcedure.query(async () => ({ installed: await rendererReady(), installing: installing !== null })),
  install: publicProcedure.mutation(async () => {
    installing ??= installRenderer().finally(() => { installing = null; });
    await installing;
    return { installed: await rendererReady() };
  }),
});
