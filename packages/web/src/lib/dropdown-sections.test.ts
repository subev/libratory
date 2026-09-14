import { describe, it, expect } from "vitest";
import { sectionsOf } from "./dropdown-sections.ts";

describe("sectionsOf", () => {
  it("groups a contiguous run of rows under one heading", () => {
    const sections = sectionsOf([
      { value: "a", group: "DeepSeek" },
      { value: "b", group: "DeepSeek" },
      { value: "c", group: "OpenAI" },
    ]);
    expect(sections.map((s) => [s.group, s.options.map((o) => o.value)])).toEqual([
      ["DeepSeek", ["a", "b"]],
      ["OpenAI", ["c"]],
    ]);
  });

  it("keeps an appended ungrouped row after the grouped ones, not inside the first section", () => {
    // The Settings default picker: an ungrouped "Automatic" row opens the list, providers follow,
    // and "Show all" is appended. Grouping by name put Show all in Automatic's own section — at the
    // top, above the catalogue it exists to reveal.
    const sections = sectionsOf([
      { value: "", label: "Automatic" },
      { value: "flash", group: "DeepSeek" },
      { value: "gpt", group: "OpenAI" },
      { value: "__all__", label: "Show all 12 models" },
    ]);
    expect(sections.map((s) => [s.group, s.options.map((o) => o.value)])).toEqual([
      ["", [""]],
      ["DeepSeek", ["flash"]],
      ["OpenAI", ["gpt"]],
      ["", ["__all__"]],
    ]);
  });

  it("splits a group that reappears later rather than merging the two runs", () => {
    // Merging would move rows out from under the position the caller gave them.
    const sections = sectionsOf([
      { value: "a", group: "X" },
      { value: "b", group: "Y" },
      { value: "c", group: "X" },
    ]);
    expect(sections.map((s) => s.options.map((o) => o.value))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("returns one headerless section when no row carries a group", () => {
    const rows: { value: string; group?: string }[] = [{ value: "a" }, { value: "b" }];
    expect(sectionsOf(rows)).toEqual([{ group: "", options: [{ value: "a" }, { value: "b" }] }]);
  });

  it("has no sections to render for an empty list", () => {
    expect(sectionsOf([])).toEqual([]);
  });
});
