import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { ensureTessdata, listOcrLanguages, removePack, startPackDownload } from "../lib/tessdata.ts";
import { TESSDATA_LANGUAGES } from "../lib/tessdata-manifest.ts";

const code = z.string().refine((c) => TESSDATA_LANGUAGES.some((l) => l.code === c), "Unknown language pack");

export const ocrLanguagesRouter = router({
  list: publicProcedure.query(async () => {
    await ensureTessdata();
    return listOcrLanguages();
  }),
  download: publicProcedure.input(z.object({ code })).mutation(({ input }) => startPackDownload(input.code)),
  remove: publicProcedure.input(z.object({ code })).mutation(({ input }) => removePack(input.code)),
});
