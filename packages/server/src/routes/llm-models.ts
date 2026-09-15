import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { availableModels, canonicalKey, llmStatus, modelChoice, modelKeySchema, setDefaultModelKey } from "../lib/llm.ts";
import { startLocalServer } from "../lib/llm-server-control.ts";
import { env } from "../env.ts";

export const llmModelsRouter = router({
  list: publicProcedure.query(async () =>
    (await availableModels()).map(({ key, label, hint, source, contextTokens, supportsTools, vision, recommended }) => ({
      key,
      label,
      hint,
      source,
      contextTokens,
      supportsTools,
      // null = not reported; the OCR model picker disables only a definite false
      vision: vision ?? null,
      // The pickers show the curated set by default and everything else behind a "show all" row;
      // see ModelPicker.
      recommended: recommended ?? false,
    })),
  ),

  status: publicProcedure.query(() => llmStatus()),

  // chosen: what the user picked in Settings (null = automatic). The rest is what a request with
  // no explicit model actually runs on — the pickers preselect it, and `steppedOver` names the
  // pick that was unavailable, which only the server can label since `list` omits it.
  //
  // chosen is canonicalized like every other reader of the stored key. Returning it raw made a
  // legacy `pro` pick look unavailable: it matches nothing in `list`, so Settings showed a phantom
  // option and warned that requests ran elsewhere, when the pick resolves to Flash and runs exactly
  // as chosen.
  getDefault: publicProcedure.query(async () => {
    const { key, label, steppedOver } = await modelChoice();
    const chosen = env.DEFAULT_LLM_MODEL ? canonicalKey(env.DEFAULT_LLM_MODEL) : null;
    return { chosen, resolved: key, resolvedLabel: label, steppedOver: steppedOver ?? null };
  }),

  setDefault: publicProcedure
    .input(z.object({ key: modelKeySchema.nullable() }))
    .mutation(({ input }) => setDefaultModelKey(input.key)),

  startLocalServer: publicProcedure
    .input(z.object({ name: z.enum(["Ollama", "LM Studio"]) }))
    .mutation(({ input }) => startLocalServer(input.name)),
});
