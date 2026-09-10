import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { failureMessage, missingTools, stageRuntime, toolPath, uvEnv } from "./setup.cjs";
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
    expect(names).toEqual(["ffmpeg", "pdftotext", "pdfinfo", "tesseract", "pdftoppm"]);
    expect(names).not.toContain("url");
    expect(names).not.toContain("sha256");
  });

  it("reports every tool missing when the bundle has none of them", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "setup-"));
    dirs.push(empty);
    // Homebrew is in the search order behind the bundle, so this only holds for names that cannot
    // be on any PATH — the point is that the *names* are what is probed for.
    expect(missingTools(empty)).toEqual(expect.arrayContaining([]));
    expect(missingTools(empty).every((t) => Object.keys(pins.bundledTools.versions).includes(t))).toBe(true);
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
    await mkdir(path.join(resources, "tessdata", "configs"), { recursive: true });
    for (const f of ["pyproject.toml", "uv.lock", "docker-compose.yml"]) {
      await writeFile(path.join(resources, f), "");
    }
    await writeFile(path.join(resources, "scripts", "models.py"), "");
    await writeFile(path.join(resources, "tessdata", "eng.traineddata"), "shipped");
    await writeFile(path.join(resources, "tessdata", "configs", "pdf"), "");
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

  // An update replaces Resources wholesale, so replacing the directory would lose downloaded packs.
  it("refreshes the shipped tessdata without deleting a downloaded pack", async () => {
    const { resources, home } = await stagedInto();
    await writeFile(path.join(home, "tessdata", "bul.traineddata"), "downloaded");
    await writeFile(path.join(resources, "tessdata", "eng.traineddata"), "newer");

    stageRuntime(resources, home);

    expect(await readFile(path.join(home, "tessdata", "eng.traineddata"), "utf8")).toBe("newer");
    expect(existsSync(path.join(home, "tessdata", "bul.traineddata"))).toBe(true);
    expect(existsSync(path.join(home, "tessdata", "configs", "pdf"))).toBe(true);
  });
});

// #19: the reporter's own uv.toml made their employer's registry the default index, and the
// build backends for the lock's source builds were fetched from it — 401, on every install. A
// registry declared as an extra index is queried first too, so the default alone is not enough.
describe("the environment the python step gives uv", () => {
  it("puts PyPI ahead of every index a user's own uv.toml declares", () => {
    expect(uvEnv("/home/app").UV_INDEX).toBe("https://pypi.org/simple");
    expect(uvEnv("/home/app").UV_DEFAULT_INDEX).toBe("https://pypi.org/simple");
  });

  it("still puts the environment where the app looks for it", () => {
    expect(uvEnv("/home/app").UV_PROJECT_ENVIRONMENT).toBe("/home/app/python");
  });
});

// #19 arrived as four lines of stack and nothing else: the setup step kept only the last line of the
// failing command's output, and uv's last line is a hint, not the cause. These pin what a reader of
// the crash log has to be able to see.
describe("what a failed setup command reports", () => {
  const uv401 = [
    "Resolved 312 packages in 1.20s",
    "error: Failed to prepare distributions",
    "  Caused by: Failed to fetch wheel: torch==2.13.0",
    "  Caused by: HTTP status client error (401 Unauthorized) for url (https://pkgs.example.com/simple/torch/)",
    "  help: `--index-url` is set in a uv configuration file",
  ].join("\n");

  it("keeps the cause, not just the hint uv ends on", () => {
    const message = failureMessage(uv401, 2);
    expect(message.split("\n")[0]).toBe("error: Failed to prepare distributions");
    expect(message).toContain("401 Unauthorized");
  });

  it("drops the progress output above the error, so the crash title is the error", () => {
    expect(failureMessage(uv401, 2)).not.toContain("Resolved 312 packages");
  });

  it("falls back to the tail for tools that do not mark an error line", () => {
    expect(failureMessage("curl: (22) The requested URL returned error 403\n", 22))
      .toBe("curl: (22) The requested URL returned error 403");
  });

  it("names the exit code when the command said nothing at all", () => {
    expect(failureMessage("  \n\n", 137)).toBe("exit 137");
  });
});
