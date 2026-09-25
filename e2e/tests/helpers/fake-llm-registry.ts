import fs from "node:fs/promises";
import { FAKE_MODEL_ID } from "../../fixtures/fake-llm.mjs";
import { LLM_MODELS_PATH } from "./env.ts";

export const FAKE_MODEL_KEY = "e2e-fake";
export const FAKE_NOTOOLS_KEY = "e2e-fake-notools";
export const FAKE_TINY_KEY = "e2e-fake-tiny";

// The server hot-reloads this file on mtime change (configModels in lib/llm.ts),
// so entries appear in every picker without a dev-server restart.
export async function registerFakeLlm(url: string): Promise<() => Promise<void>> {
  const previous = await fs.readFile(LLM_MODELS_PATH).catch(() => null);
  const base = { hint: "e2e stub", baseUrl: `${url}/v1`, modelId: FAKE_MODEL_ID, contextTokens: 8192, supportsTools: false };
  const entries = [
    { ...base, key: FAKE_MODEL_KEY, label: "E2E Fake", supportsTools: true },
    { ...base, key: FAKE_NOTOOLS_KEY, label: "E2E Fake NoTools" },
    // Tools on, so the assistant can be pointed at it and refuse it by name for its context
    { ...base, key: FAKE_TINY_KEY, label: "E2E Fake Tiny", contextTokens: 100, supportsTools: true },
  ];
  await fs.writeFile(LLM_MODELS_PATH, JSON.stringify(entries, null, 2));
  return async () => {
    if (previous === null) await fs.unlink(LLM_MODELS_PATH).catch(() => {});
    else await fs.writeFile(LLM_MODELS_PATH, previous);
  };
}
