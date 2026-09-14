import { describe, it, expect } from "vitest";
import { collapsibleModels, fallbackModelKey } from "./use-llm-models.ts";
import type { LlmModel } from "./use-llm-models.ts";

const model = (key: string, recommended: boolean) => ({ key, recommended }) as LlmModel;

const models = [
  model("flash", true),
  model("gpt", true),
  model("deepseek:deepseek-v4-pro", false),
  model("openai:gpt-5.6-sol", false),
];

describe("collapsibleModels", () => {
  it("keeps the curated picks and hides the discovered catalogue behind one row", () => {
    expect(collapsibleModels(models, "flash", false)).toEqual({ shown: [models[0], models[1]], hidden: 2 });
  });

  it("keeps the selected model visible even when it is not curated", () => {
    // Dropdown reads its trigger label off the options it is handed, so hiding the current pick
    // would leave the control looking unset.
    const { shown } = collapsibleModels(models, "openai:gpt-5.6-sol", false);
    expect(shown.map((m) => m.key)).toContain("openai:gpt-5.6-sol");
  });

  it("shows everything once expanded, and offers no further row", () => {
    expect(collapsibleModels(models, "flash", true)).toEqual({ shown: models, hidden: 0 });
  });

  it("offers no expand row when nothing is hidden", () => {
    const curated = [model("flash", true), model("gpt", true)];
    expect(collapsibleModels(curated, "flash", false).hidden).toBe(0);
  });
});

describe("fallbackModelKey", () => {
  const withTools = (key: string, recommended: boolean, supportsTools = true) =>
    ({ key, recommended, supportsTools }) as LlmModel;
  const list = [withTools("flash", true), withTools("gpt", true), withTools("deepseek:new", false)];

  it("fills in an unresolved picker with the default", () => {
    expect(fallbackModelKey(list, "", "gpt", false)).toBe("gpt");
  });

  it("falls to the first usable model when the default cannot do what is needed", () => {
    const noToolsDefault = [withTools("flash", true, false), withTools("gpt", true, true)];
    expect(fallbackModelKey(noToolsDefault, "", "flash", true)).toBe("gpt");
  });

  it("leaves a saved pick alone, and never rewrites it when the list lacks it", () => {
    // The regression: a provider listing failing for one window made a configured model absent, and
    // the picker persisted a replacement over the book's stored choice.
    expect(fallbackModelKey(list, "deepseek:new", "flash", false)).toBeUndefined();
    expect(fallbackModelKey(list, "openai:not-listed-right-now", "flash", false)).toBeUndefined();
  });

  it("does nothing until there is a list to choose from", () => {
    expect(fallbackModelKey([], "", "flash", false)).toBeUndefined();
  });
});
