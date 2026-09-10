import { describe, it, expect } from "vitest";
import { cloudDef, cloudKey, parseCloudKey } from "./cloud-models.ts";

describe("parseCloudKey", () => {
  it("reads a discovered key back into its provider and model id", () => {
    expect(parseCloudKey("deepseek:deepseek-flash")).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    expect(parseCloudKey("openai:gpt-5.2")).toEqual({ provider: "openai", modelId: "gpt-5.2" });
  });

  it("keeps the model id whole when it carries a colon of its own", () => {
    expect(parseCloudKey("anthropic:claude-opus-4.5:x")).toEqual({ provider: "anthropic", modelId: "claude-opus-4.5:x" });
  });

  it("refuses keys that name no keyed provider, so local ids are not mistaken for cloud ones", () => {
    for (const key of ["flash", "ollama:llama3.2", "lmstudio:qwen/qwen3-8b", "openai-compatible:x", ":", "deepseek:"]) {
      expect(parseCloudKey(key)).toBeNull();
    }
  });
});

describe("cloudDef", () => {
  it("falls back to the provider's conventions for a model no catalog knows", () => {
    const def = cloudDef("deepseek", "deepseek-something-new");
    expect(def.key).toBe(cloudKey("deepseek", "deepseek-something-new"));
    expect(def.label).toBe("deepseek-something-new");
    // DeepSeek's wire format takes a temperature and json_object; OpenAI's rejects the temperature
    expect(def.supportsTemperature).toBe(true);
    expect(def.supportsJsonFormat).toBe(true);
    // An unconfirmed window is called out rather than passed off as known
    expect(def.contextNote).toMatch(/context unconfirmed/);
  });

  it("takes the provider's own numbers over anything else, and stops calling them unconfirmed", () => {
    const def = cloudDef("anthropic", "claude-nothing-in-the-catalog", {
      label: "Claude Something",
      contextTokens: 200_000,
      supportsTools: true,
      supportsJsonFormat: true,
    });
    expect(def.label).toBe("Claude Something");
    expect(def.contextTokens).toBe(200_000);
    expect(def.supportsJsonFormat).toBe(true);
    expect(def.contextNote).toBeUndefined();
  });
});
