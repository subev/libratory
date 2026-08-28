import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

function resolveCliBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@vivliostyle/cli/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { bin: Record<string, string> };
  const bin = pkg.bin.vivliostyle;
  if (!bin) throw new Error("@vivliostyle/cli exposes no vivliostyle binary");
  return path.join(path.dirname(pkgPath), bin);
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

// Rendering one paragraph is the only way to make the CLI fetch its browser: there is no install
// subcommand, and the download happens solely as a side effect of a build.
export async function installRenderer(): Promise<void> {
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
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(stderr ? `${message}\n${stderr.slice(-2000)}` : message, { cause: err });
  }
}
