import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pending, readState, writeState } from "./runtime.cjs";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<{ resources: string; home: string }> {
  const d = await mkdtemp(path.join(tmpdir(), "runtime-"));
  dirs.push(d);
  const resources = path.join(d, "resources");
  const home = path.join(d, "home");
  await mkdir(resources);
  await mkdir(home);
  await writeFile(path.join(resources, "uv.lock"), "version = 1\n");
  return { resources, home };
}

describe("what a launch has to bring forward", () => {
  it("treats a machine with no state as a first run, not an update", async () => {
    const { resources, home } = await scratch();
    const p = pending(resources, home);
    expect(p.fresh).toBe(true);
    expect(p.python).toBe(true);
    expect(p.models).toBe(true);
  });

  it("does nothing when the shipped lockfile is the one already installed", async () => {
    const { resources, home } = await scratch();
    writeState(home, { ...pending(resources, home).want, essentialModels: true });
    const p = pending(resources, home);
    expect(p.python).toBe(false);
    expect(p.models).toBe(false);
    expect(p.fresh).toBe(false);
  });

  // The case the whole file exists for: the app bundle is replaced, its uv.lock differs, and the
  // 2.4 GB environment beside it is still the previous release's.
  it("asks for a Python sync when a new release ships a different lockfile", async () => {
    const { resources, home } = await scratch();
    writeState(home, { ...pending(resources, home).want, essentialModels: true });
    await writeFile(path.join(resources, "uv.lock"), "version = 2\n");
    const p = pending(resources, home);
    expect(p.python).toBe(true);
    expect(p.fresh).toBe(false);
    expect(p.models).toBe(false);
  });

  // An interrupted update must repeat, not be skipped
  it("keeps asking until the step that succeeded is the one recorded", async () => {
    const { resources, home } = await scratch();
    await writeFile(path.join(resources, "uv.lock"), "version = 3\n");
    expect(pending(resources, home).python).toBe(true);
    expect(pending(resources, home).python).toBe(true);
    writeState(home, pending(resources, home).want);
    expect(pending(resources, home).python).toBe(false);
    expect(readState(home).essentialModels).toBeUndefined();
  });

  // A Mac that installed a release before Piper existed has no piperLock at all: updating must
  // install Piper without touching the 2.4 GB environment, and a later pin change reinstalls it
  it("installs Piper on an update that adds it, and again when its pins change", async () => {
    const { resources, home } = await scratch();
    await mkdir(path.join(resources, "scripts"));
    await writeFile(path.join(resources, "scripts", "requirements-piper.txt"), "piper-tts==1.8.0\n");
    writeState(home, { pythonLock: pending(resources, home).want.pythonLock, essentialModels: true });

    const before = pending(resources, home);
    expect(before.piper).toBe(true);
    expect(before.python).toBe(false);

    writeState(home, { piperLock: before.want.piperLock });
    expect(pending(resources, home).piper).toBe(false);

    await writeFile(path.join(resources, "scripts", "requirements-piper.txt"), "piper-tts==1.9.0\n");
    expect(pending(resources, home).piper).toBe(true);
  });
});
