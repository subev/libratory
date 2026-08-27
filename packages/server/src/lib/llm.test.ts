import { describe, it, expect } from "vitest";
import { modelKeySchema } from "./llm.ts";

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
