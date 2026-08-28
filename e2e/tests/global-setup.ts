import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs/promises";
import { trpcQuery, purgeProfile } from "./helpers/trpc.ts";
import { LLM_MODELS_PATH } from "./helpers/env.ts";

// Interrupted runs (e.g. a test stopped from the Playwright UI) can skip fixture
// teardown — sweep the state they left behind before this run starts.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const ctx = await request.newContext({ baseURL });

  let profiles: { id: string; name: string }[];
  try {
    profiles = await trpcQuery(ctx, "profiles.list");
  } catch (err) {
    throw new Error(
      `Dev server not reachable at ${baseURL} — start it with \`pnpm dev\` from the repo root first.\n(${err})`, { cause: err },
    );
  }

  await Promise.all(
    profiles
      .filter((p) => p.name.startsWith("e2e "))
      .map(async (p) => {
        await purgeProfile(ctx, p.id);
        console.log(`swept stale e2e profile "${p.name}"`);
      }),
  );

  const registry = JSON.parse(await fs.readFile(LLM_MODELS_PATH, "utf8").catch(() => "[]")) as { key?: string }[];
  if (registry.length > 0 && registry.every((e) => String(e.key).startsWith("e2e-fake"))) {
    await fs.unlink(LLM_MODELS_PATH);
    console.log("swept stale e2e llm-models.json");
  }

  await ctx.dispose();
}
