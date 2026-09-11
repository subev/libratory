import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";
import { secretStatus, setSecret, SECRET_VARS } from "../lib/secrets.ts";
import { cloudKeyNotes } from "../lib/llm.ts";
import { invalidateCloudDiscovery } from "../lib/cloud-models.ts";

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
});
