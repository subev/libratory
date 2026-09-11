import { describe, it, expect } from "vitest";
import { modelKeySchema, canonicalKey, resolveLlm } from "./llm.ts";
import { env } from "../env.ts";

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
});
