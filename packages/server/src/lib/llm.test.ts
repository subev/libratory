import { describe, it, expect, afterEach } from "vitest";
import { contextExceeded, defaultModelKey, modelKeySchema, canonicalKey, resolveLlm, type LlmModelDef } from "./llm.ts";
import { env } from "../env.ts";
import { useTempDataDir } from "../../test/data-dir.ts";

let restoreDataDir: (() => void) | undefined;
afterEach(() => {
  restoreDataDir?.();
  restoreDataDir = undefined;
});

describe("modelKeySchema", () => {
  it("accepts the shapes real keys have", () => {
    for (const key of ["flash", "claude-haiku", "ollama:llama3.2", "ollama:hf.co/user/repo:Q4_K_M", "lmstudio:qwen3-27b"]) {
      expect(modelKeySchema.safeParse(key).success).toBe(true);
    }
  });

  it("refuses a key that would write a second line into .env", () => {
    expect(modelKeySchema.safeParse("flash\nDEEPSEEK_API_KEY=stolen").success).toBe(false);
    expect(modelKeySchema.safeParse("flash\rDEEPSEEK_API_KEY=stolen").success).toBe(false);
  });

  it("refuses empty and over-long keys", () => {
    expect(modelKeySchema.safeParse("").success).toBe(false);
    expect(modelKeySchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("canonicalKey", () => {
  it("maps an old key onto the model it named", () => {
    expect(canonicalKey("pro")).toBe("deepseek:deepseek-v4-pro");
  });

  it("leaves every other key alone", () => {
    for (const key of ["flash", "claude", "deepseek:deepseek-v4-pro", "ollama:llama3.2", "anything-else"]) {
      expect(canonicalKey(key)).toBe(key);
    }
  });
});

describe("resolveLlm", () => {
  it("resolves a saved legacy key to the model it named rather than failing as unknown", async () => {
    // Hermetic: with a cached listing present this key is checked against it, so the test has to
    // say which listing it is resolving against rather than inherit the checkout's.
    restoreDataDir = useTempDataDir();
    const previous = env.DEEPSEEK_API_KEY;
    env.DEEPSEEK_API_KEY = "test-key";
    try {
      const { def } = await resolveLlm("pro");
      expect(def.key).toBe("deepseek:deepseek-v4-pro");
      expect(def.modelId).toBe("deepseek-v4-pro");
    } finally {
      env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("refuses a cloud key the provider's own listing does not carry", async () => {
    restoreDataDir = useTempDataDir({ deepseek: { at: Date.now(), ids: ["deepseek-flash"] } });
    const previous = env.DEEPSEEK_API_KEY;
    env.DEEPSEEK_API_KEY = "test-key";
    try {
      await expect(resolveLlm("deepseek:deepseek-nnot-a-model")).rejects.toThrow("Unknown AI model");
    } finally {
      env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("lets a key through when the listing we hold is too old to contradict it", async () => {
    // A model released since that listing would otherwise be refused for not being in a set
    // fetched before it existed.
    restoreDataDir = useTempDataDir({
      deepseek: { at: Date.now() - 25 * 60 * 60 * 1000, ids: ["deepseek-flash"] },
    });
    const previous = env.DEEPSEEK_API_KEY;
    env.DEEPSEEK_API_KEY = "test-key";
    try {
      const { def } = await resolveLlm("deepseek:released-since-the-listing");
      expect(def.modelId).toBe("released-since-the-listing");
    } finally {
      env.DEEPSEEK_API_KEY = previous;
    }
  });
});

describe("defaultModelKey", () => {
  it("keeps a saved cloud pick no listing names, rather than rerouting the job", async () => {
    // An empty listing is what a failed probe leaves behind, and it must not be able to move every
    // job that named no model onto the automatic choice — nor tell the user their pick is gone.
    restoreDataDir = useTempDataDir();
    const previousDefault = env.DEFAULT_LLM_MODEL;
    const previousKey = env.ANTHROPIC_API_KEY;
    env.DEFAULT_LLM_MODEL = "anthropic:claude-opus-4-7";
    env.ANTHROPIC_API_KEY = "test-key";
    try {
      expect(await defaultModelKey([])).toBe("anthropic:claude-opus-4-7");
    } finally {
      env.DEFAULT_LLM_MODEL = previousDefault;
      env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it("keeps a saved local pick while its server is running", async () => {
    // A local key is neither pinned nor a cloud key, so nothing but the server can say whether it
    // still runs. Judging it by what the pinned list carries drops it and bills a cloud model
    // instead — the same reroute the listing was just removed from, one provider over.
    restoreDataDir = useTempDataDir();
    const previousDefault = env.DEFAULT_LLM_MODEL;
    const previousDeepseek = env.DEEPSEEK_API_KEY;
    // A configured cloud key, so the automatic choice is a real alternative the test can catch.
    env.DEEPSEEK_API_KEY = "test-key";
    env.DEFAULT_LLM_MODEL = "ollama:llama3.2";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      const body = url.endsWith("/api/tags")
        ? { models: [{ name: "llama3.2" }] }
        : url.endsWith("/api/ps")
          ? { models: [] }
          : { capabilities: ["completion", "tools"], model_info: { "general.architecture": "llama" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      expect(await defaultModelKey()).toBe("ollama:llama3.2");
    } finally {
      globalThis.fetch = realFetch;
      env.DEFAULT_LLM_MODEL = previousDefault;
      env.DEEPSEEK_API_KEY = previousDeepseek;
    }
  });

  it("still falls through to the automatic choice when the pick cannot run", async () => {
    restoreDataDir = useTempDataDir();
    const previousDefault = env.DEFAULT_LLM_MODEL;
    const previousAnthropic = env.ANTHROPIC_API_KEY;
    const previousDeepseek = env.DEEPSEEK_API_KEY;
    env.DEFAULT_LLM_MODEL = "anthropic:claude-opus-4-7";
    env.ANTHROPIC_API_KEY = undefined;
    env.DEEPSEEK_API_KEY = "test-key";
    try {
      expect(await defaultModelKey()).toBe("flash");
    } finally {
      env.DEFAULT_LLM_MODEL = previousDefault;
      env.ANTHROPIC_API_KEY = previousAnthropic;
      env.DEEPSEEK_API_KEY = previousDeepseek;
    }
  });
});

describe("contextExceeded", () => {
  const def = (contextAssumed?: boolean): LlmModelDef => ({
    key: "flash",
    label: "V4.1 Flash",
    hint: "",
    source: "DeepSeek",
    provider: "deepseek",
    modelId: "deepseek-flash",
    contextTokens: 128_000,
    contextAssumed,
    supportsTemperature: true,
    supportsTools: true,
    supportsJsonFormat: true,
  });

  it("refuses work that does not fit a window the model reported", () => {
    expect(contextExceeded(def(false), 200_000)).toBe(true);
    expect(contextExceeded(def(false), 100_000)).toBe(false);
  });

  it("does not refuse work on a window that was only assumed", () => {
    // The per-provider number stands in for metadata we could not read. Skipping a book on it is
    // worse than trying: the provider's own answer names its real limit.
    expect(contextExceeded(def(true), 200_000)).toBe(false);
  });
});
