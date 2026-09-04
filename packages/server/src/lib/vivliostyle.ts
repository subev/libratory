import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { env } from "../env.ts";

const execFileAsync = promisify(execFile);

// The desktop app is one compiled binary with no node_modules beside it, so the CLI is installed
// into VIVLIOSTYLE_DIR at the same moment the renderer is downloaded. Kept in step with the
// dependency the repo resolves — see vivliostyle.test.ts.
export const CLI_VERSION = "11.1.0";

// process.execPath is that compiled binary, which re-runs the server unless BUN_BE_BUN makes it
// behave as the bun CLI; node ignores the variable.
const bunEnv = { ...process.env, BUN_BE_BUN: "1" };

const INSTALLED_BIN = path.join(env.VIVLIOSTYLE_DIR, "node_modules", "@vivliostyle", "cli", "dist", "cli.js");

function bundledCliBin(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@vivliostyle/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { bin: Record<string, string> };
    const bin = pkg.bin.vivliostyle;
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch {
    return null;
  }
}

function resolveCliBin(): string {
  const bin = bundledCliBin() ?? (existsSync(INSTALLED_BIN) ? INSTALLED_BIN : null);
  if (!bin) throw new Error("The page renderer is not installed yet — download it from the export panel");
  return bin;
}

export function cliInstalled(): boolean {
  return bundledCliBin() !== null || existsSync(INSTALLED_BIN);
}

// `bun install` rather than a 233 MB addition to the DMG: the CLI carries a native canvas, a
// wasm PDF library and 500-odd packages, and it is useless without the browser downloaded here
// anyway.
export async function installCli(): Promise<void> {
  if (cliInstalled()) return;
  await mkdir(env.VIVLIOSTYLE_DIR, { recursive: true });
  await writeFile(
    path.join(env.VIVLIOSTYLE_DIR, "package.json"),
    JSON.stringify({ name: "libratory-vivliostyle", private: true, dependencies: { "@vivliostyle/cli": CLI_VERSION } }, null, 2),
    "utf-8",
  );
  await execFileAsync(process.execPath, ["install"], { cwd: env.VIVLIOSTYLE_DIR, env: bunEnv, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (!cliInstalled()) throw new Error("Installing the page renderer left no vivliostyle CLI behind");
}

// Vivliostyle fetches its own browser on first use, into this cache. Knowing whether it is there
// is what lets the UI say "345 MB first" instead of appearing to hang for the length of a download.
// The layout mirrors the CLI's own getCacheDir(): Library/Caches on a Mac, XDG on Linux.
const CACHE_ROOT = process.platform === "darwin"
  ? path.join(homedir(), "Library", "Caches")
  : (process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"));
const BROWSER_CACHE = path.join(CACHE_ROOT, "vivliostyle", "browsers", "chrome");

// What a finished download holds, one directory per fetched version.
const EXECUTABLE_IN_VERSION = process.platform === "darwin"
  ? path.join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
  : path.join("chrome-linux64", "chrome");

// Debian calls it chromium, Ubuntu chromium-browser, Google's own package google-chrome. A system
// browser needs no 345 MB fetch, and it arrives with its shared libraries resolved — the fetched
// Chrome on a headless server asks for X libraries nobody installed.
const SYSTEM_BROWSERS = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];

export async function systemBrowser(): Promise<string | null> {
  // macOS keeps the download flow: it is proven there, and "Chrome.app somewhere" is a guess.
  if (process.platform === "darwin") return null;
  for (const candidate of SYSTEM_BROWSERS) {
    if (await stat(candidate).then((s) => s.isFile(), () => false)) return candidate;
  }
  return null;
}

// Any entry is not a finished download: @puppeteer/browsers creates the version directory before
// it unpacks, so a cancelled 345 MB fetch leaves a folder that reads as installed forever — and
// with it a permanently hidden Install button and an Export PDF that always fails.
export async function rendererInstalled(dir = BROWSER_CACHE): Promise<boolean> {
  const versions = await readdir(dir).catch(() => []);
  for (const version of versions) {
    const app = path.join(dir, version, EXECUTABLE_IN_VERSION);
    if (await stat(app).then((s) => s.isFile(), () => false)) return true;
  }
  return false;
}

// Both halves have to be there before an export can run: the CLI itself and a browser to render in.
export async function rendererReady(): Promise<boolean> {
  return cliInstalled() && ((await systemBrowser()) !== null || await rendererInstalled());
}

// Rendering one paragraph is the only way to make the CLI fetch its browser: there is no install
// subcommand, and the download happens solely as a side effect of a build.
export async function installRenderer(): Promise<void> {
  await installCli();
  const dir = await mkdtemp(path.join(tmpdir(), "vivliostyle-install-"));
  try {
    const htmlPath = path.join(dir, "probe.html");
    await writeFile(htmlPath, "<!doctype html><title>.</title><p>.</p>", "utf-8");
    await buildDocument(htmlPath, path.join(dir, "probe.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function buildDocument(htmlPath: string, outputPath: string): Promise<void> {
  const bin = resolveCliBin();
  const browser = await systemBrowser();
  const browserArgs = browser ? ["--executable-browser", browser] : [];
  try {
    await execFileAsync(process.execPath, [bin, "build", htmlPath, "-o", outputPath, ...browserArgs, "--log-level", "silent", "--timeout", "1800"], {
      env: bunEnv,
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(stderr ? `${message}\n${stderr.slice(-2000)}` : message, { cause: err });
  }
}
