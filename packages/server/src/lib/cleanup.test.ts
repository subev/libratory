import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupChunk } from "./cleanup.ts";
import { llmChat } from "./llm.ts";

vi.mock("./llm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm.ts")>()),
  llmChat: vi.fn(),
}));

const chatMock = vi.mocked(llmChat);

beforeEach(() => {
  chatMock.mockReset();
});

describe("cleanupChunk", () => {
  it("sends the chunk text with a conservative temperature and allows empty output", async () => {
    chatMock.mockResolvedValue("Cleaned text.");
    const result = await cleanupChunk({ text: "F0 REWO R D\n\nSome prose." });
    expect(result).toBe("Cleaned text.");
    const [system, user, opts] = chatMock.mock.calls[0] ?? [];
    expect(user).toBe("F0 REWO R D\n\nSome prose.");
    expect(opts).toEqual({ temperature: 0.3, allowEmpty: true, timeoutMs: 600_000 });
    expect(system).toContain("NEVER paraphrase");
    expect(system).toContain("Keep the original language");
    expect(system).toContain("Output ONLY the cleaned text");
  });

  it("passes through an empty response for garbage-only chunks", async () => {
    chatMock.mockResolvedValue("");
    await expect(cleanupChunk({ text: "Ц— , _ \\ ~ _\\ . . \\" })).resolves.toBe("");
  });
});
