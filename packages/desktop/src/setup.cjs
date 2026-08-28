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

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, env: { ...process.env, PATH: toolPath(opts.resources), ...opts.env } });
    let tail = "";
    const keep = (b) => { tail = (tail + String(b)).slice(-4000); opts.onOutput?.(String(b)); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(tail) : reject(new Error(tail.trim().split("\n").at(-1) || `exit ${code}`))));
  });
}

// The bundle is read-only in spirit and replaced wholesale by an update, so the pieces the runtime
// writes next to — the lockfile uv resolves against, the scripts it runs — are copied out once per
// version rather than referenced in place.
function stageRuntime(resources, home) {
  mkdirSync(home, { recursive: true });
  cpSync(path.join(resources, "scripts"), path.join(home, "scripts"), { recursive: true });
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

async function syncPython(home, onOutput) {
  const uv = await ensureUv(home, onOutput);
  await sh(uv, ["sync", "--frozen", "--project", home], {
    // uv puts the environment beside pyproject.toml by default; this puts it where we want it
    env: { UV_PROJECT_ENVIRONMENT: path.join(home, "python") },
    onOutput,
  });
  return pythonBin(home);
}

async function fetchEssentialModels(python, home, onOutput) {
  await sh(python, [path.join(home, "scripts", "models.py"), "--essential"], {
    env: { HF_HUB_OFFLINE: "0" },
    onOutput,
  });
}

module.exports = { missingTools, toolPath, stageRuntime, pythonBin, syncPython, fetchEssentialModels };
