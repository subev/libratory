import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { DownloadTracker } from "./downloads.ts";
import { bgttsInstallState } from "./engine-install.ts";
import { installedLocalEngines } from "./tts.ts";

const saved = { UV_PATH: env.UV_PATH, BGTTS_ENV_PATH: env.BGTTS_ENV_PATH, LIBRATORY_RUNTIME: env.LIBRATORY_RUNTIME };
afterEach(() => Object.assign(env, saved));

describe("bgttsInstallState", () => {
  it("is installable with a uv to build with, never inside a container", () => {
    env.UV_PATH = "/bin/sh";
    env.LIBRATORY_RUNTIME = "desktop";
    expect(bgttsInstallState().installable).toBe(true);
    env.LIBRATORY_RUNTIME = "docker";
    expect(bgttsInstallState().installable).toBe(false);
    env.LIBRATORY_RUNTIME = "desktop";
    env.UV_PATH = "/nonexistent/uv";
    expect(bgttsInstallState().installable).toBe(false);
  });
});

describe("installedLocalEngines", () => {
  // install_bgtts.sh creates the venv's python first and the voice model last
  it("does not count a venv the install script has not finished", () => {
    const venv = mkdtempSync(path.join(tmpdir(), "bgtts-"));
    try {
      env.BGTTS_ENV_PATH = path.join(venv, "bin");
      rmSync(env.BGTTS_ENV_PATH, { recursive: true, force: true });
      expect(installedLocalEngines().bgtts).toBe(false);
      writeFileSync(path.join(venv, ".installing"), "");
      mkdirSync(env.BGTTS_ENV_PATH);
      writeFileSync(path.join(env.BGTTS_ENV_PATH, "python"), "");
      expect(installedLocalEngines().bgtts).toBe(false);
      rmSync(path.join(venv, ".installing"));
      expect(installedLocalEngines().bgtts).toBe(true);
    } finally {
      rmSync(venv, { recursive: true, force: true });
    }
  });
});

describe("DownloadTracker", () => {
  it("reports the step a multi-step install is on, and clears it when the run ends", async () => {
    const tracker = new DownloadTracker();
    const done = new Promise<void>((resolve) => {
      tracker.start("x", "/bin/sh", ["-c", `echo '{"type":"step","label":"MioCodec"}'; sleep 0.3`], resolve);
    });
    await expect.poll(() => tracker.progressOf("x")).toBe("MioCodec");
    await done;
    expect(tracker.progressOf("x")).toBeNull();
    expect(tracker.error("x")).toBeNull();
  });
});
