import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rendererInstalled } from "./vivliostyle.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "viv-cache-"));
  dirs.push(dir);
  return dir;
}

describe("rendererInstalled", () => {
  it("is false when the browser cache does not exist", async () => {
    expect(await rendererInstalled(path.join(await scratch(), "never-created"))).toBe(false);
  });

  // Vivliostyle creates the directory before it finishes downloading, so its presence alone
  // would report a renderer that cannot render yet
  it("is false when the cache exists but is empty", async () => {
    const dir = path.join(await scratch(), "chrome");
    await mkdir(dir, { recursive: true });
    expect(await rendererInstalled(dir)).toBe(false);
  });

  // The one that matters: @puppeteer/browsers makes the version directory first and unpacks into
  // it, so a cancelled download leaves this exact shape. Counting entries called it installed,
  // which hid the Install button for good and made every export fail.
  it("is false when a version directory exists but the browser was never unpacked", async () => {
    const dir = path.join(await scratch(), "chrome");
    await mkdir(path.join(dir, "mac_arm-150.0.7871.115"), { recursive: true });
    await writeFile(path.join(dir, "mac_arm-150.0.7871.115", "marker"), "");
    expect(await rendererInstalled(dir)).toBe(false);
  });

  it("is true once the browser executable is in there", async () => {
    const dir = path.join(await scratch(), "chrome");
    // The running platform's own layout — the scan looks for exactly one shape per OS.
    const exe = process.platform === "darwin"
      ? path.join(dir, "mac_arm-150.0.7871.115", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
      : path.join(dir, "linux-150.0.7871.115", "chrome-linux64", "chrome");
    await mkdir(path.dirname(exe), { recursive: true });
    await writeFile(exe, "");
    expect(await rendererInstalled(dir)).toBe(true);
  });
});
