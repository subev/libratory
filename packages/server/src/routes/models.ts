import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { listModelBundles, startBundleDownload } from "../lib/model-bundles.ts";
import { INSTALLABLE_ENGINES, engineInstallState, startEngineInstall } from "../lib/engine-install.ts";
import { installedLocalEngines } from "../lib/tts.ts";
import { env } from "../env.ts";

export const modelsRouter = router({
  list: publicProcedure.query(() => listModelBundles()),
  engines: publicProcedure.query(() => ({
    installed: installedLocalEngines(),
    runtime: env.LIBRATORY_RUNTIME,
    install: { bgtts: engineInstallState("bgtts"), loudkit: engineInstallState("loudkit") },
  })),
  installEngine: publicProcedure
    .input(z.object({ engine: z.enum(INSTALLABLE_ENGINES) }))
    .mutation(({ input }) => startEngineInstall(input.engine)),
  download: publicProcedure
    .input(z.object({ id: z.string().min(1).max(40) }))
    .mutation(({ input }) => startBundleDownload(input.id)),
});
