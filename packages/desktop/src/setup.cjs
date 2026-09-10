// Everything scripts/setup.sh does, minus the terminal. Each function reports progress through a
// callback and is safe to run again — a first run that dies halfway resumes rather than restarts.
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, copyFileSync, cpSync, rmSync, readFileSync } = require("node:fs");
const path = require("node:path");

// Pinned and checksummed rather than `curl | sh`: piping an installer into a shell gives errors
// like "curl: (56) Failure writing output to destination" when anything goes wrong, which tells a
// user nothing, and it runs an unverified script as them. The pin is shared with scripts/setup.sh.
// Never require()d by relative path: that resolves inside app.asar, which holds packages/desktop
// and not the repo's scripts/. Packaged, scripts/ sits beside the app (extraResources) and is
// copied into HOME by stageRuntime; in a checkout it is three levels up.
/** @type {Record<string, any> | null} */
let pinCache = null;
function pins(dir) {
  if (pinCache) return pinCache;
  const candidates = [path.join(dir, "scripts", "pins.json"), path.resolve(__dirname, "../../../scripts/pins.json")];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not find pins.json (looked in ${candidates.join(", ")})`);
  const parsed = JSON.parse(readFileSync(found, "utf8"));
  pinCache = parsed;
  return parsed;
}

// The tools the workers shell out to ship inside the bundle — copied out of Homebrew at build time
// with their whole dylib closure, rewritten to @loader_path and re-signed, by
// scripts/bundle-tools.py. Homebrew stays in the search order behind them so a developer running
// from source keeps working, and a GUI app's PATH (which has neither Homebrew directory) is never
// what decides.

function toolDirs(resources) {
  return [...(resources ? [path.join(resources, "bin")] : []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

function missingTools(resources) {
  const tools = Object.keys(pins(resources).bundledTools.versions);
  return tools.filter((name) => !toolDirs(resources).some((dir) => existsSync(path.join(dir, name))));
}

function toolPath(resources) {
  return toolDirs(resources).join(":");
}

// The last line of a failing command is reliably the least useful part of it: uv reports the cause
// as a block — "error: Failed to fetch …", then the "Caused by:" line naming the HTTP status, then a
// hint — so keeping one line turned a 401 from a private package registry into a bare stack trace
// with nothing in it (#19). Start at the last "error:" when the tool marks one, else keep the tail.
const FAILURE_LINES = 6;
function failureMessage(tail, code) {
  const lines = tail.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return `exit ${code}`;
  const marked = lines.findLastIndex((l) => /^error\b/i.test(l));
  const from = marked === -1 ? Math.max(0, lines.length - FAILURE_LINES) : marked;
  return lines.slice(from, from + FAILURE_LINES).join("\n");
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, PATH: toolPath(opts.resources), ...opts.env } });
    let tail = "";
    const keep = (b) => { tail = (tail + String(b)).slice(-4000); opts.onOutput?.(String(b)); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(tail) : reject(new Error(failureMessage(tail, code)))));
  });
}

// The bundle is read-only in spirit and replaced wholesale by an update, so the pieces the runtime
// writes next to — the lockfile uv resolves against, the scripts it runs — are copied out once per
// version rather than referenced in place.
function stageRuntime(resources, home) {
  mkdirSync(home, { recursive: true });
  cpSync(path.join(resources, "scripts"), path.join(home, "scripts"), { recursive: true });
  // Copied over, never replaced: an update must not take a downloaded language pack with it.
  cpSync(path.join(resources, "tessdata"), path.join(home, "tessdata"), { recursive: true, force: true });
  for (const f of ["pyproject.toml", "uv.lock", "docker-compose.yml"]) {
    copyFileSync(path.join(resources, f), path.join(home, f));
  }
}

async function ensureUv(home, onOutput) {
  const dir = path.join(home, "uv");
  const uv = path.join(dir, "uv");
  if (existsSync(uv)) return uv;

  const { uv: pinned } = pins(home);
  const build = pinned[process.arch];
  if (!build) throw new Error(`No uv build for ${process.arch}`);
  mkdirSync(dir, { recursive: true });

  // Downloaded by the app rather than a browser, so it carries no quarantine flag and needs no
  // notarisation of ours — the same reason the Python environment lives out here at all.
  const tarball = path.join(dir, "uv.tar.gz");
  const url = `https://github.com/astral-sh/uv/releases/download/${pinned.version}/uv-${build.target}.tar.gz`;
  onOutput?.(`Downloading uv ${pinned.version}`);
  await sh("/usr/bin/curl", ["-fsSL", "--retry", "3", "-o", tarball, url]);

  const got = (await sh("/usr/bin/shasum", ["-a", "256", tarball])).trim().split(/\s+/)[0];
  if (got !== build.sha256) {
    rmSync(tarball, { force: true });
    throw new Error(`uv checksum mismatch — expected ${build.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`);
  }

  await sh("/usr/bin/tar", ["-xzf", tarball, "--strip-components=1", "-C", dir]);
  rmSync(tarball, { force: true });
  return uv;
}

function pythonBin(home) {
  return path.join(home, "python", "bin", "python");
}

// UV_PROJECT_ENVIRONMENT puts the venv where we want it instead of beside pyproject.toml. PyPI is
// forced because --frozen downloads from the lock but still resolves build backends for the source
// builds in it (docopt, jieba, the mlx git dep) from the user's configured indexes — an employer's
// registry answered those with 401 (#19). Both vars: UV_INDEX outranks the extra indexes a uv.toml
// declares, UV_DEFAULT_INDEX replaces the one it marks `default`.
function uvEnv(home) {
  return {
    UV_PROJECT_ENVIRONMENT: path.join(home, "python"),
    UV_INDEX: "https://pypi.org/simple",
    UV_DEFAULT_INDEX: "https://pypi.org/simple",
  };
}

async function syncPython(home, onOutput) {
  const uv = await ensureUv(home, onOutput);
  await sh(uv, ["sync", "--frozen", "--project", home], { env: uvEnv(home), onOutput });
  return pythonBin(home);
}

async function fetchEssentialModels(python, home, onOutput) {
  await sh(python, [path.join(home, "scripts", "models.py"), "--essential"], {
    env: { HF_HUB_OFFLINE: "0" },
    onOutput,
  });
}

module.exports = { missingTools, toolPath, stageRuntime, pythonBin, uvEnv, syncPython, fetchEssentialModels, failureMessage };
