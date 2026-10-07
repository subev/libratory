import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { listModelBundles, startBundleDownload } from "../lib/model-bundles.ts";
import { bgttsInstallState, startBgttsInstall } from "../lib/engine-install.ts";
import { installedLocalEngines } from "../lib/tts.ts";
import { env } from "../env.ts";

export const modelsRouter = router({
  list: publicProcedure.query(() => listModelBundles()),
  engines: publicProcedure.query(() => ({
    installed: installedLocalEngines(),
    runtime: env.LIBRATORY_RUNTIME,
    install: { bgtts: bgttsInstallState() },
  })),
  installEngine: publicProcedure
    .input(z.object({ engine: z.literal("bgtts") }))
    .mutation(() => startBgttsInstall()),
  download: publicProcedure
    .input(z.object({ id: z.string().min(1).max(40) }))
    .mutation(({ input }) => startBundleDownload(input.id)),
});
