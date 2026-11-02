import { z } from "zod";

import { router, publicProcedure } from "../trpc.ts";
import { POCKET_VOICES, pocketEngineInstalled, pocketLanguageByCode } from "../lib/pocket.ts";
import {
  listPocketLanguages,
  pocketCloningState,
  startPocketCloningDownload,
  startPocketLanguageDownload,
} from "../lib/pocket-languages.ts";
import { deleteCustomPocketVoice, listCustomPocketVoices } from "../lib/pocket-voices.ts";

export const pocketVoicesRouter = router({
  list: publicProcedure.query(async () => {
    const [custom, installed, cloning] = await Promise.all([
      listCustomPocketVoices(),
      pocketEngineInstalled(),
      pocketCloningState(),
    ]);
    return { voices: POCKET_VOICES, custom, installed, cloning };
  }),

  languages: publicProcedure.query(() => listPocketLanguages()),

  downloadLanguage: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(({ input }) => {
      const language = pocketLanguageByCode(input.code);
      if (!language) throw new Error(`Unknown Pocket TTS language: ${input.code}`);
      return startPocketLanguageDownload(language);
    }),

  downloadCloning: publicProcedure.mutation(() => startPocketCloningDownload()),

  deleteCustom: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await deleteCustomPocketVoice(input.id);
      return { ok: true };
    }),
});
