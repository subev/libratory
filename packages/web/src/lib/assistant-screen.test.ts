import { describe, expect, it } from "vitest";
import { panelShownOn, screenOf } from "./assistant-screen.ts";

describe("assistant screen", () => {
  it("stays off the reading surfaces and the gallery", () => {
    expect(panelShownOn("/")).toBe(true);
    expect(panelShownOn("/folders/abc")).toBe(true);
    expect(panelShownOn("/books/abc")).toBe(true);
    expect(panelShownOn("/books/abc/read")).toBe(false);
    expect(panelShownOn("/books/abc/ocr")).toBe(false);
    expect(panelShownOn("/open")).toBe(false);
    expect(panelShownOn("/components")).toBe(false);
  });

  it("names the book a page is about", () => {
    expect(screenOf("/books/abc")).toEqual({ route: "/books/abc", bookId: "abc" });
    expect(screenOf("/")).toEqual({ route: "/" });
  });
});
