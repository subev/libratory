import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { loadTheme, saveTheme, applyTheme } from "./theme.ts";

const attributes = new Map<string, string>();

beforeEach(() => {
  const store = new Map<string, string>();
  attributes.clear();
  Object.assign(globalThis, {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        removeAttribute: (name: string) => void attributes.delete(name),
      },
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
});

describe("theme", () => {
  it("falls back to auto for a missing or unknown preference", () => {
    expect(loadTheme()).toBe("auto");
    localStorage.setItem("theme", "sepia");
    expect(loadTheme()).toBe("auto");
  });

  it("stores the choice and pins the ramp with data-theme", () => {
    saveTheme("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(attributes.get("data-theme")).toBe("dark");
  });

  // Auto must leave the attribute off entirely, or the OS query can never win again
  it("drops data-theme when going back to auto", () => {
    saveTheme("dark");
    saveTheme("auto");
    expect(attributes.has("data-theme")).toBe(false);
  });

  it("applies a preference without storing it", () => {
    applyTheme("light");
    expect(attributes.get("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBeNull();
  });

  // The pre-paint bootstrap cannot import this module, so nothing but this pins the shared key
  it("shares its storage key with the bootstrap in index.html", () => {
    expect(readFileSync(new URL("../../index.html", import.meta.url), "utf8")).toContain('getItem("theme")');
  });
});
