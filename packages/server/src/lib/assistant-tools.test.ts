import { describe, expect, it, vi } from "vitest";
import { getDb } from "../../test/setup.ts";
import { DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { assistantTools, needsApproval, TOOL_TIERS, tierOf, type AssistantToolSet } from "./assistant-tools.ts";
import { CitationCatalog } from "./chat-tools.ts";
import { books } from "../schema.ts";

// A ToolSet's execute takes the tool's own input type, unknown to the caller here
const call = (set: AssistantToolSet, name: string, args: Record<string, unknown>) =>
  set.tools[name]!.execute!(args as never, { toolCallId: "t", messages: [], context: undefined });

describe("assistant tools", () => {
  it("classifies every tool the MCP server registers", async () => {
    // With the chat's search attached, since read_passage only exists with it
    const everything = await assistantTools(DEFAULT_PROFILE_ID, { scope: { profileId: DEFAULT_PROFILE_ID }, catalog: new CitationCatalog(), llm: { model: {} as never, def: { key: "t", label: "t", supportsTools: true, contextTokens: 1000 } as never } });
    try {
      expect(Object.keys(everything.tools).sort()).toEqual(Object.keys(TOOL_TIERS).sort());
    } finally {
      await everything.close();
    }
  });

  it("asks before a call that changes something, per call rather than per tool", () => {
    expect(needsApproval({ toolCall: { toolName: "list_books", input: {} } })).toBe("not-applicable");
    expect(needsApproval({ toolCall: { toolName: "update_chapter", input: { id: "c", title: "Two" } } })).toBe("not-applicable");
    expect(needsApproval({ toolCall: { toolName: "update_chapter", input: { id: "c", text: "Rewritten" } } })).toBe("user-approval");
    expect(needsApproval({ toolCall: { toolName: "upload_book", input: { paths: ["/a.pdf"] } } })).toBe("user-approval");
    expect(needsApproval({ toolCall: { toolName: "unknown_tool", input: {} } })).toBe("user-approval");
  });

  it("answers with what the tool said, not a transcript of it", async () => {
    await getDb().insert(books).values({ title: "Sea Stories", filename: "s.pdf", pdfPath: "/tmp/s.pdf", profileId: DEFAULT_PROFILE_ID });
    const set = await assistantTools(DEFAULT_PROFILE_ID);
    try {
      const listed = (await call(set, "list_books", {})) as { books: { title: string }[] };
      expect(listed.books.map((b) => b.title)).toEqual(["Sea Stories"]);
      await expect(call(set, "get_chapter", { id: crypto.randomUUID() })).rejects.toThrow(/Chapter not found/);
    } finally {
      await set.close();
    }
  });

  it("tiers a call by what it changes, not only by its name", () => {
    expect(tierOf("update_chapter", { id: "c", title: "Two" })).toBe("quick");
    expect(tierOf("update_chapter", { id: "c", text: "Rewritten" })).toBe("confirm");
    expect(tierOf("set_book_settings", { id: "b", title: "T", folder: "Work" })).toBe("quick");
    expect(tierOf("set_book_settings", { id: "b", voice: "kokoro:af_heart" })).toBe("confirm");
    expect(tierOf("redetect_chapters", { id: "b" })).toBe("confirm");
    expect(tierOf("redetect_chapters", { id: "b", llmChapterDetection: true })).toBe("spend");
    expect(tierOf("upload_book", { paths: ["/a.pdf"], ocrEngine: "llm" })).toBe("spend");
    expect(tierOf("list_books", {})).toBe("read");
  });
});
