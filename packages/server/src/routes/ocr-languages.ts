import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { ensureTessdata, listOcrLanguages, packCodeSchema, removePack, startPackDownload } from "../lib/tessdata.ts";

export const ocrLanguagesRouter = router({
  list: publicProcedure.query(async () => {
    await ensureTessdata();
    return listOcrLanguages();
  }),
  download: publicProcedure.input(z.object({ code: packCodeSchema })).mutation(({ input }) => startPackDownload(input.code)),
  remove: publicProcedure.input(z.object({ code: packCodeSchema })).mutation(({ input }) => removePack(input.code)),
});
