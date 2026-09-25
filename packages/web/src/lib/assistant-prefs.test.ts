import { describe, expect, it } from "vitest";
import { clampPanelWidth, MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "./assistant-prefs.ts";

describe("assistant panel width", () => {
  it("stays between its bounds and never past half the window", () => {
    expect(clampPanelWidth(100, 1440)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(500, 1440)).toBe(500);
    expect(clampPanelWidth(900, 1600)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(700, 1100)).toBe(550);
    // A window too narrow for even the minimum keeps the minimum: the panel can be collapsed instead
    expect(clampPanelWidth(500, 500)).toBe(MIN_PANEL_WIDTH);
  });
});
