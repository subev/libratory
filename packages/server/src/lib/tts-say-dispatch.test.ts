import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const { mockWriteFile, mockSpawn, mockExecFile, procs } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  procs: [] as MockProc[],
  mockSpawn: vi.fn(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as MockProc;

    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = vi.fn();

    procs.push(proc);
    return proc;
  }),
  mockExecFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
    cb(null, "Daria (Enhanced)    bg_BG    # Hello! My name is Daria.\n");
  }),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  execFile: mockExecFile,
}));

vi.mock("node:readline", () => ({
  createInterface: ({ input }: { input: EventEmitter }) => ({
    on(event: string, callback: (line: string) => void) {
      input.on(event, callback);
      return this;
    },
    close() {},
  }),
}));

vi.mock("./kokoro.ts", () => ({
  synthesize: vi.fn(async () => {}),
  KokoroAbortedError: class KokoroAbortedError extends Error {},
}));

import { synthesize } from "./tts.ts";

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

describe("tts macOS say dispatcher", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockWriteFile.mockClear();
    procs.length = 0;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("runs the say script with the voice and scaled rate", async () => {
    const log = vi.fn(async () => {});

    const run = synthesize({
      inputText: "Първи откъс.",
      outputPath: "/tmp/out.wav",
      voice: "say:daria-enhanced",
      speed: 1.2,
      log,
    });

    await flushAsyncWork();

    expect(log).toHaveBeenCalledWith("Starting macOS say synthesis (2 words, voice: Daria (Enhanced), speed 1.2x)");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, spawnArgs] = mockSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(spawnArgs[0]).toMatch(/synthesize_say_tts\.py$/);
    expect(spawnArgs).toContain("Daria (Enhanced)");
    expect(spawnArgs.join(" ")).toContain("--rate 210");

    procs[0]?.emit("close", 0);
    await run;
  });

  it("rejects a say voice that is not installed", async () => {
    await expect(synthesize({
      inputText: "Първи откъс.",
      outputPath: "/tmp/out.wav",
      voice: "say:samantha",
      speed: 1,
    })).rejects.toThrow(/not installed/i);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

});
