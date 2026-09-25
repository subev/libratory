import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { LLM_SECRETS, secretStatus, setSecret, SECRET_VARS } from "../lib/secrets.ts";
import { cloudKeyNotes } from "../lib/llm.ts";
import { invalidateCloudDiscovery, verifyKey } from "../lib/cloud-models.ts";

export const secretsRouter = router({
  // Values are written to the .env file and never sent back — only whether one is set, and …last4
  list: publicProcedure.query(() => secretStatus(cloudKeyNotes())),

  set: publicProcedure
    .input(z.object({ envVar: z.enum(SECRET_VARS), value: z.string().max(256).nullable() }))
    .mutation(({ input }) => {
      setSecret(input.envVar, input.value);
      // The listing cached while this key was absent says nothing about what the key unlocks, and
      // without this it stands for the rest of the window — a key just pasted would look rejected.
      invalidateCloudDiscovery();
    }),

  // The assistant panel's Connect: one test request to the provider, and the key is saved only
  // if it was accepted. Settings keeps its plain save, which works offline.
  connect: publicProcedure
    .input(z.object({ envVar: z.enum(SECRET_VARS), value: z.string().trim().min(1).max(256) }))
    .mutation(async ({ input }) => {
      const secret = LLM_SECRETS.find((s) => s.envVar === input.envVar);
      if (!secret) throw new Error("Only an AI provider key can be checked");
      const verdict = await verifyKey(secret.provider, input.value);
      if (!verdict.ok) throw new Error(verdict.reason);
      setSecret(input.envVar, input.value);
      invalidateCloudDiscovery();
      return { label: secret.label };
    }),
});
