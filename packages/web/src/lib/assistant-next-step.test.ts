import { describe, expect, it } from "vitest";
import { nextStep, type NextStepBook } from "./assistant-next-step.ts";

const chapter = (over: Partial<NextStepBook["chapters"][number]> = {}) => ({ selected: true, status: "suspended", audioPath: null, ...over });

function book(over: Partial<NextStepBook> = {}): NextStepBook {
  return {
    id: "b",
    kind: "pdf",
    status: "pending",
    structureConfirmedAt: null,
    outputPath: null,
    assembleQueued: false,
    files: [{ status: "raw", hasRawText: true }],
    chapters: [],
    ...over,
  };
}

describe("nextStep", () => {
  it("walks the loop: text, extract, review, narrate, output, done", () => {
    expect(nextStep(book({ files: [{ status: "raw", hasRawText: false }] })).step).toBe("text");
    expect(nextStep(book()).step).toBe("extract");
    expect(nextStep(book()).action?.to).toBe("/books/b?extract=1");
    expect(nextStep(book({ chapters: [chapter()] })).step).toBe("review");
    expect(nextStep(book({ chapters: [chapter()], structureConfirmedAt: "2026-09-25" })).step).toBe("narrate");
    expect(nextStep(book({ chapters: [chapter({ audioPath: "/a.m4a", status: "done" })], structureConfirmedAt: "2026-09-25" })).step).toBe("output");
    expect(nextStep(book({ chapters: [chapter({ audioPath: "/a.m4a", status: "done" })], structureConfirmedAt: "2026-09-25", outputPath: "/b.m4b" })).step).toBe("done");
  });

  it("has nothing to press while the book is working", () => {
    expect(nextStep(book({ status: "extracting" })).action).toBeNull();
    expect(nextStep(book({ chapters: [chapter({ status: "synthesizing" })], structureConfirmedAt: "2026-09-25" })).action).toBeNull();
    expect(nextStep(book({ chapters: [chapter({ audioPath: "/a.m4a", status: "done" })], structureConfirmedAt: "2026-09-25", assembleQueued: true })).title).toBe("Assembling");
  });

  it("skips the review for a book that has no structure to review", () => {
    expect(nextStep(book({ kind: "api", files: [], chapters: [chapter()] })).step).toBe("narrate");
  });

  it("counts only selected chapters as owed", () => {
    const chapters = [chapter({ status: "synthesizing", selected: false }), chapter({ audioPath: "/a.m4a", status: "done" })];
    expect(nextStep(book({ chapters, structureConfirmedAt: "2026-09-25" })).step).toBe("output");
  });
});
