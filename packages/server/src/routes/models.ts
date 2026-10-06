import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { listModelBundles, startBundleDownload } from "../lib/model-bundles.ts";
import { installedLocalEngines } from "../lib/tts.ts";

export const modelsRouter = router({
  list: publicProcedure.query(() => listModelBundles()),
  engines: publicProcedure.query(() => installedLocalEngines()),
  download: publicProcedure
    .input(z.object({ id: z.string().min(1).max(40) }))
    .mutation(({ input }) => startBundleDownload(input.id)),
});
