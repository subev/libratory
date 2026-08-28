import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { missingTools, stageRuntime, toolPath } from "./setup.cjs";
import pins from "../../../scripts/pins.json" with { type: "json" };

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// A shipped DMG reported "Missing url, sha256, versions from the app bundle" because pins.json's
// bundledTools grew from a list of names into { url, sha256, versions } and this read its top-level
// keys — so it looked for executables called "url" and "sha256". Nothing typed the boundary, and
// nothing ran it, so the rename reached a release.
describe("the tools the app expects to find in its bundle", () => {
  it("names real executables, not the keys around them", () => {
    const names = Object.keys(pins.bundledTools.versions);
    expect(names).toEqual(["ffmpeg", "pdftotext", "pdfinfo"]);
    expect(names).not.toContain("url");
    expect(names).not.toContain("sha256");
  });

  it("reports every tool missing when the bundle has none of them", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "setup-"));
    dirs.push(empty);
    // Homebrew is in the search order behind the bundle, so this only holds for names that cannot
    // be on any PATH — the point is that the *names* are what is probed for.
    expect(missingTools(empty)).toEqual(expect.arrayContaining([]));
    expect(missingTools(empty).every((t) => ["ffmpeg", "pdftotext", "pdfinfo"].includes(t))).toBe(true);
  });

  it("finds them once they are where the bundle puts them", async () => {
    const resources = await mkdtemp(path.join(tmpdir(), "setup-"));
    dirs.push(resources);
    await mkdir(path.join(resources, "bin"), { recursive: true });
    for (const name of Object.keys(pins.bundledTools.versions)) {
      await writeFile(path.join(resources, "bin", name), "");
    }
    expect(missingTools(resources)).toEqual([]);
  });

  it("puts the bundle ahead of Homebrew, so a GUI app's PATH is never what decides", () => {
    const dirs = toolPath("/somewhere/Resources").split(":");
    expect(dirs[0]).toBe("/somewhere/Resources/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });
});

// Two bug reports in ten minutes came from the same blind spot: this machine's home directory has
// been populated by months of runs, so a step reading a file it never wrote worked here and nowhere
// else. These pin stageRuntime's contract against a genuinely empty directory. They would not have
// caught the ordering bug itself — that was staging happening three steps after the database step
// read what it writes — which is why the comment above the call in main.cjs says so out loud.
describe("what a first run has to put in place before any step reads it", () => {
  async function stagedInto(): Promise<{ resources: string; home: string }> {
    const d = await mkdtemp(path.join(tmpdir(), "stage-"));
    dirs.push(d);
    const resources = path.join(d, "resources");
    const home = path.join(d, "home");
    await mkdir(path.join(resources, "scripts"), { recursive: true });
    for (const f of ["pyproject.toml", "uv.lock", "docker-compose.yml"]) {
      await writeFile(path.join(resources, f), "");
    }
    await writeFile(path.join(resources, "scripts", "models.py"), "");
    stageRuntime(resources, home);
    return { resources, home };
  }

  // docker-compose.yml is the one the database step opens by absolute path, and staging used to
  // happen three steps later — so a fresh install failed with "no such file or directory".
  it("stages docker-compose.yml, which the database step reads from home", async () => {
    const { home } = await stagedInto();
    expect(existsSync(path.join(home, "docker-compose.yml"))).toBe(true);
  });

  it("stages the lockfile and pyproject the python step syncs against", async () => {
    const { home } = await stagedInto();
    expect(existsSync(path.join(home, "uv.lock"))).toBe(true);
    expect(existsSync(path.join(home, "pyproject.toml"))).toBe(true);
  });

  it("stages the scripts the server spawns", async () => {
    const { home } = await stagedInto();
    expect(existsSync(path.join(home, "scripts", "models.py"))).toBe(true);
  });

  it("creates the home directory when there is not one yet", async () => {
    const { home } = await stagedInto();
    expect(existsSync(home)).toBe(true);
  });
});

