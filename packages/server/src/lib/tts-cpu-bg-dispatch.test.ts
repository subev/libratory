import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWriteFile, mockSpawn, spawnFails } = vi.hoisted(() => ({
  spawnFails: { current: false },
  mockWriteFile: vi.fn(async () => {}),
  mockSpawn: vi.fn(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };

    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = vi.fn();

    queueMicrotask(() => {
      if (spawnFails.current) proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      else proc.emit("close", 0);
    });

    return proc;
  }),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
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

describe("tts CPU Bulgarian dispatcher", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
    mockWriteFile.mockClear();
    spawnFails.current = false;
  });

  it("runs BgTTS-38M in its own venv", async () => {
    await synthesize({ inputText: "Здравей, свят.", outputPath: "/tmp/out.wav", voice: "bg-bgtts:female", speed: 1 });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/\.venv-bgtts\/bin\/python$/),
      expect.arrayContaining([expect.stringMatching(/synthesize_bgtts\.py$/), "--voice", "female"]),
      expect.any(Object),
    );
  });

  it("passes the speed to Piper", async () => {
    await synthesize({ inputText: "Здравей, свят.", outputPath: "/tmp/out.wav", voice: "bg-piper:dimitar", speed: 1.25 });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/\.venv-piper\/bin\/python$/),
      expect.arrayContaining([expect.stringMatching(/synthesize_piper_tts\.py$/), "--voice", "dimitar", "--speed", "1.25"]),
      expect.any(Object),
    );
  });

  it("says how to install an engine whose venv was never built", async () => {
    spawnFails.current = true;

    await expect(
      synthesize({ inputText: "Здравей, свят.", outputPath: "/tmp/out.wav", voice: "bg-bgtts:male", speed: 1 }),
    ).rejects.toThrow(/pnpm run setup --bgtts/);
  });
});
