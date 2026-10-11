import { describe, it, expect, afterEach } from "vitest";
import { cloudDef, cloudKey, cloudModelListed, newestFirst, parseCloudKey, withoutSnapshots } from "./cloud-models.ts";
import { useTempDataDir } from "../../test/data-dir.ts";

let restoreDataDir: (() => void) | undefined;
afterEach(() => {
  restoreDataDir?.();
  restoreDataDir = undefined;
});

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

  it("marks a window it had to guess at, so nothing downstream skips work on it", () => {
    expect(cloudDef("deepseek", "deepseek-something-new").contextAssumed).toBe(true);
  });

  it("does not mark a window the provider reported", () => {
    const def = cloudDef("anthropic", "claude-x", { label: "X", contextTokens: 200_000 });
    expect(def.contextAssumed).toBe(false);
  });

  it("reads the window out of a listing a previous process fetched", () => {
    restoreDataDir = useTempDataDir({
      deepseek: {
        at: Date.now(),
        ids: ["deepseek-flash"],
        meta: { "deepseek-flash": { label: "V4.1 Flash", contextTokens: 1_000_000 } },
      },
    });
    // resolveLlm rebuilds this def from the key alone, with no listing in hand: without the cached
    // one it would fall to DeepSeek's 128k convention and refuse a book that fits in the real 1M.
    const def = cloudDef("deepseek", "deepseek-flash");
    expect(def.contextTokens).toBe(1_000_000);
    expect(def.contextAssumed).toBe(false);
  });
});

describe("cloudModelListed", () => {
  it("says nothing when no listing is cached, so a failed probe never refuses a key", () => {
    restoreDataDir = useTempDataDir();
    expect(cloudModelListed("deepseek", "deepseek-anything")).toBeUndefined();
  });

  it("answers for a model the provider listed", () => {
    restoreDataDir = useTempDataDir({ deepseek: { at: Date.now(), ids: ["deepseek-flash"] } });
    expect(cloudModelListed("deepseek", "deepseek-flash")).toBe(true);
    expect(cloudModelListed("deepseek", "deepseek-typo")).toBe(false);
  });

  it("stops vouching for a listing old enough to predate a release", () => {
    restoreDataDir = useTempDataDir({
      deepseek: { at: Date.now() - 25 * 60 * 60 * 1000, ids: ["deepseek-flash"] },
    });
    expect(cloudModelListed("deepseek", "released-yesterday")).toBeUndefined();
  });
});

describe("withoutSnapshots", () => {
  it("drops a dated snapshot beside its alias and keeps one that stands alone", () => {
    const ids = ["gpt-5.5", "gpt-5.5-2026-04-23", "gpt-4-0613", "gpt-4", "o3-2025-04-16", "gpt-5.6-sol"];
    expect(withoutSnapshots(ids.map((modelId) => ({ modelId }))).map((m) => m.modelId)).toEqual(["gpt-5.5", "gpt-4", "o3-2025-04-16", "gpt-5.6-sol"]);
  });
});

describe("newestFirst", () => {
  it("puts the newest release first and an undated model, the newest of all, before it", () => {
    const def = (label: string, releasedAt?: string) => ({ ...cloudDef("openai", label.toLowerCase()), label, releasedAt });
    const sorted = newestFirst([def("Old", "2024-05-13"), def("New", "2026-07-09"), def("Unknown"), def("Mid", "2025-08-07")]);
    expect(sorted.map((m) => m.label)).toEqual(["Unknown", "New", "Mid", "Old"]);
  });
});
