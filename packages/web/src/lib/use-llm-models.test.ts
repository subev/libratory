import { describe, it, expect } from "vitest";
import { collapsibleModels } from "./use-llm-models.ts";
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
