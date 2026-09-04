import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { availableModels, llmStatus, modelChoice, modelKeySchema, setDefaultModelKey } from "../lib/llm.ts";
import { startLocalServer } from "../lib/llm-server-control.ts";
import { env } from "../env.ts";

export const llmModelsRouter = router({
  list: publicProcedure.query(async () =>
    (await availableModels()).map(({ key, label, hint, source, contextTokens, supportsTools }) => ({
      key,
      label,
      hint,
      source,
      contextTokens,
      supportsTools,
    })),
  ),

  status: publicProcedure.query(() => llmStatus()),

  // chosen: what the user picked in Settings (null = automatic). The rest is what a request with
  // no explicit model actually runs on — the pickers preselect it, and `steppedOver` names the
  // pick that was unavailable, which only the server can label since `list` omits it.
  getDefault: publicProcedure.query(async () => {
    const { key, label, steppedOver } = await modelChoice();
    return { chosen: env.DEFAULT_LLM_MODEL ?? null, resolved: key, resolvedLabel: label, steppedOver: steppedOver ?? null };
  }),

  setDefault: publicProcedure
    .input(z.object({ key: modelKeySchema.nullable() }))
    .mutation(({ input }) => setDefaultModelKey(input.key)),

  startLocalServer: publicProcedure
    .input(z.object({ name: z.enum(["Ollama", "LM Studio"]) }))
    .mutation(({ input }) => startLocalServer(input.name)),
});
