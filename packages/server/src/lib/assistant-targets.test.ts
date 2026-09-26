import { describe, expect, it } from "vitest";
import { APP_TARGETS, appUrlFor, describeTarget } from "./assistant-targets.ts";

describe("assistant targets", () => {
  it("builds the URLs the web app answers to", () => {
    expect(appUrlFor({ target: "library" })).toBe("/");
    expect(appUrlFor({ target: "folder", folderId: "f" })).toBe("/folders/f");
    expect(appUrlFor({ target: "chapters", bookId: "b" })).toBe("/books/b?tab=chapters");
    expect(appUrlFor({ target: "extract", bookId: "b" })).toBe("/books/b?dialog=extract");
    expect(appUrlFor({ target: "review-chapters", bookId: "b" })).toBe("/books/b?tab=chapters&dialog=structure");
    expect(appUrlFor({ target: "chapter", bookId: "b", chapterId: "c" })).toBe("/books/b?tab=chapters&chapter=c");
    expect(appUrlFor({ target: "reader", bookId: "b", chapterIndex: 2, atMs: 1500.4 })).toBe("/books/b/read?chapter=2&t=1500");
    expect(appUrlFor({ target: "reader", bookId: "b" })).toBe("/books/b/read");
    expect(appUrlFor({ target: "book", bookId: "b", variant: "German" })).toBe("/books/b?variant=German");
    expect(appUrlFor({ target: "chapters", bookId: "b", variant: "Chinese (Simplified)" })).toBe("/books/b?tab=chapters&variant=Chinese+%28Simplified%29");
    expect(appUrlFor({ target: "reader", bookId: "b", variant: "German" })).toBe("/books/b/read");
    expect(describeTarget({ target: "chapters", bookId: "b", variant: "German" })).toBe("Opened the chapters, German version");
  });

  it("refuses a target without what it needs", () => {
    expect(() => appUrlFor({ target: "book" })).toThrow(/bookId/);
    expect(() => appUrlFor({ target: "chapter", bookId: "b" })).toThrow(/chapterId/);
    expect(() => appUrlFor({ target: "folder" })).toThrow(/folderId/);
  });

  it("names every target", () => {
    for (const target of APP_TARGETS) expect(describeTarget({ target })).toMatch(/^Opened/);
  });
});
