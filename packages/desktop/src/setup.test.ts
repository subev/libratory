import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { missingTools, repairVenvPaths, stageRuntime, toolPath } from "./setup.cjs";
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

// pdf2audio became Libratory, the home moved with it, and 109 of the venv's 114 console scripts
// went on exec'ing a python that no longer existed. Everything that used one reported "exited with
// code 126" and nothing said why, because the lock hash still matched and the python step never
// looked past it.
describe("a venv whose scripts still name the folder the app used to live in", () => {
  async function venv(root: string, stale: string) {
    const bin = path.join(root, "python", "bin");
    await mkdir(bin, { recursive: true });
    // The wrapper pip generates: a /bin/sh header that re-execs the file with the venv's python.
    await writeFile(path.join(bin, "marker_single"), `#!/bin/sh\n'''exec' '${stale}/bin/python' "$0" "$@"\n`);
    await chmod(path.join(bin, "marker_single"), 0o755);
    await writeFile(path.join(bin, "activate"), `VIRTUAL_ENV="${stale}"\nexport VIRTUAL_ENV\n`);
    await writeFile(path.join(bin, "compiled"), Buffer.from([0x7f, 0x45, 0x4c, 0x00, 0x01]));
    return bin;
  }

  // The space in "Application Support" is the whole difficulty: matching without the quotes around
  // the path captures from the space onwards and rewrites it into nonsense.
  const STALE = "/Users/x/Library/Application Support/pdf2audio/python";

  it("repoints them at the home it is running from, and says how many", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "libratory-venv-"));
    dirs.push(home);
    const bin = await venv(home, STALE);

    expect(repairVenvPaths(home)).toBe(2);

    const expected = path.join(home, "python");
    expect(await readFile(path.join(bin, "marker_single"), "utf8")).toContain(`'${expected}/bin/python'`);
    expect(await readFile(path.join(bin, "activate"), "utf8")).toContain(`VIRTUAL_ENV="${expected}"`);
  });

  it("leaves the executable bit and any compiled file alone", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "libratory-venv-"));
    dirs.push(home);
    const bin = await venv(home, STALE);

    repairVenvPaths(home);

    expect((await stat(path.join(bin, "marker_single"))).mode & 0o777).toBe(0o755);
    expect((await readFile(path.join(bin, "compiled"))).length).toBe(5);
  });

  it("does nothing when they already point here, however often it runs", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "libratory-venv-"));
    dirs.push(home);
    await venv(home, path.join(home, "python"));

    expect(repairVenvPaths(home)).toBe(0);
    expect(repairVenvPaths(home)).toBe(0);
  });

  it("does not mind a home with no venv in it yet", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "libratory-venv-"));
    dirs.push(home);
    expect(repairVenvPaths(home)).toBe(0);
  });
});
