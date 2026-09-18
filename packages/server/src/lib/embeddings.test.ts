import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";

function fakeProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { write: vi.fn() }, kill: vi.fn(),
  });
  child.kill.mockImplementation(() => { child.emit("close", null); return true; });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { stop?.(); vi.useRealTimers(); });

describe("embedding deadlines", () => {
  it("falls back when startup never becomes ready, and eventually stops the hung process", async () => {
    const child = fakeProcess();
    const { embedQuery, stopEmbeddings } = await import("./embeddings.ts");
    stop = stopEmbeddings;
    const result = embedQuery("question");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBeNull();
    expect(child.stdin.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(280_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not cancel a concurrent batch or submit the expired query after startup", async () => {
    const child = fakeProcess();
    const { embedQuery, embedTexts, stopEmbeddings } = await import("./embeddings.ts");
    stop = stopEmbeddings;
    const query = embedQuery("question");
    const batch = embedTexts(["book passage"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await query).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write('{"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(child.stdin.write.mock.calls[0]?.[0]));
    expect(request.texts).toEqual(["book passage"]);
    child.stdout.write(JSON.stringify({ id: request.id, vectors: [[1, 2]] }) + "\n");
    expect(await batch).toEqual([[1, 2]]);
  });

  it("uses one deadline for startup and inference together", async () => {
    const child = fakeProcess();
    const { embedQuery, stopEmbeddings } = await import("./embeddings.ts");
    stop = stopEmbeddings;
    const result = embedQuery("question");
    await vi.advanceTimersByTimeAsync(15_000);
    child.stdout.write('{"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeNull();
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
  });
});
