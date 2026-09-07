import { describe, expect, it } from "vitest";
import { dur, preselectLanguage } from "./ocr-try.ts";

describe("dur", () => {
  it("reads well at every scale", () => {
    expect(dur(8.7)).toBe("9s");
    expect(dur(8.7 * 312)).toBe("about 45 min");
    expect(dur(70.4 * 312)).toBe("about 6h 6m");
    expect(dur(5400)).toBe("about 1h 30m");
    expect(dur(7200)).toBe("about 2h 00m");
  });
});

describe("language preselection", () => {
  it("prefers the book's own language, then the script, then English", () => {
    expect(preselectLanguage("fra", ["bul"])).toBe("fra");
    expect(preselectLanguage(null, ["bul", "rus"])).toBe("bul");
    expect(preselectLanguage(null, [])).toBe("eng");
  });
});
