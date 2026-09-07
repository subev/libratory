import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { bundleInstalled } from "../lib/model-bundles.ts";
import { SURYA_BUNDLE } from "../lib/ocr-surya.ts";
import { detectScript, renderTryPage, tesseractPage, tryTarget } from "../lib/ocr-try.ts";
import { ensureTessdata, installedPacks } from "../lib/tessdata.ts";
import { TESSDATA_LANGUAGES } from "../lib/tessdata-manifest.ts";
import { packsForScript } from "../lib/tesseract-languages.ts";

const target = z.object({ bookId: z.string().uuid(), fileIndex: z.number().int().min(0), page: z.number().int().min(1) });
const pack = z.string().refine((c) => TESSDATA_LANGUAGES.some((l) => l.code === c), "Unknown language pack");

export const ocrTryRouter = router({
  page: publicProcedure.input(target).query(async ({ input }) => {
    const { file, pageCount, page } = await tryTarget(input.bookId, input.fileIndex, input.page);
    const { width, height } = await renderTryPage(input.bookId, input.fileIndex, file.pdfPath, page);
    await ensureTessdata();
    const [script, installedLanguages, surya] = await Promise.all([detectScript(input.bookId, input.fileIndex, file.pdfPath, page), installedPacks(), bundleInstalled(SURYA_BUNDLE)]);
    return {
      page,
      pageCount,
      width,
      height,
      imageUrl: `/ocr/try/${input.bookId}/${input.fileIndex}/${page}.png`,
      script,
      candidates: packsForScript(script),
      installedLanguages,
      bundleInstalled: surya,
    };
  }),
  tesseract: publicProcedure.input(target.extend({ language: pack })).mutation(async ({ input }) => {
    const { file, page } = await tryTarget(input.bookId, input.fileIndex, input.page);
    const { png, width } = await renderTryPage(input.bookId, input.fileIndex, file.pdfPath, page);
    return tesseractPage(png, input.language, width);
  }),
});
