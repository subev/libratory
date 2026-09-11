// Required by main.cjs, so it is .cjs: an Electron main process has no build step, and a second
// copy of these paths living in main.cjs is how the Colima and Rancher socket handling ended up
// tested but never shipped.
const { access, constants } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { homedir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);

// A GUI app launched from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin — no /usr/local/bin, no
// /opt/homebrew/bin. `docker` lives in neither, so probing $PATH reports "no Docker" on machines
// that are running it perfectly well. These are where the four common runtimes put things.
const CLI_CANDIDATES = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
  "/usr/bin/docker",
];

const SOCKET_CANDIDATES = [
  "/var/run/docker.sock",
  path.join(homedir(), ".docker/run/docker.sock"),
  path.join(homedir(), ".orbstack/run/docker.sock"),
  path.join(homedir(), ".colima/default/docker.sock"),
  path.join(homedir(), ".rd/docker.sock"),
];

async function firstExisting(paths) {
  for (const p of paths) {
    if (await access(p, constants.F_OK).then(() => true, () => false)) return p;
  }
  return null;
}

// A socket that exists is not a daemon that answers — Docker Desktop leaves one behind when it is
// quit — so the CLI still has the last word on whether anything is actually running.
async function detectDocker() {
  const cli = await firstExisting(CLI_CANDIDATES);
  if (!cli) return { kind: "missing" };

  const env = await dockerEnv(cli);
  try {
    const { stdout } = await run(cli, ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000, env });
    const version = stdout.trim();
    return version ? { kind: "ready", cli, version, env } : { kind: "installed-not-running", cli };
  } catch {
    return { kind: "installed-not-running", cli };
  }
}

// Every registry call shells out to a credential helper sitting beside the CLI, and the minimal
// PATH that hides the CLI hides docker-credential-osxkeychain too — so a pull died with "error
// getting credentials", which reads as a broken login rather than a broken search path (#20). The
// CLI's own directory comes first, so it answers with the helper shipped alongside it.
function pathWithDocker(cli) {
  const dirs = [path.dirname(cli), ...CLI_CANDIDATES.map((p) => path.dirname(p)), ...(process.env.PATH || "").split(":")];
  return [...new Set(dirs.filter(Boolean))].join(":");
}

// Colima and Rancher Desktop never create /var/run/docker.sock, so without DOCKER_HOST every
// `docker` call fails and the app tells a working machine that Docker is not running.
async function dockerEnv(cli) {
  const socket = await firstExisting(SOCKET_CANDIDATES);
  return { ...process.env, PATH: pathWithDocker(cli), ...(socket ? { DOCKER_HOST: `unix://${socket}` } : {}) };
}

// Two facts most people downloading an audiobook app do not have: what Docker is, and that it has
// to be *running*, not merely installed. A one-line "install Docker" left both unsaid.
const DOCKER_HELP = {
  missing: {
    detail: "Not installed",
    title: "Libratory needs Docker",
    body: "Your library lives in a database, and Docker is the free program that runs it. It is a normal app: download it, drag it to Applications, open it once, and leave it running in the menu bar.",
    links: [
      { label: "Get Docker Desktop (recommended)", url: "https://www.docker.com/products/docker-desktop/" },
      { label: "Or OrbStack — lighter, Mac only", url: "https://orbstack.dev/download" },
    ],
  },
  "installed-not-running": {
    detail: "Installed, but not running",
    title: "Docker is installed — it just is not running",
    body: "Open Docker from your Applications folder and wait for its menu-bar icon to stop animating, then press Check again. Turning on \"Start Docker Desktop when you sign in\" in its settings means you will not see this screen again.",
    links: [],
  },
};

function dockerAdvice(state) {
  if (state.kind === "ready") return `Docker ${state.version}`;
  return DOCKER_HELP[state.kind].detail;
}

function dockerHelp(state) {
  return state.kind === "ready" ? null : DOCKER_HELP[state.kind];
}

module.exports = { CLI_CANDIDATES, SOCKET_CANDIDATES, firstExisting, detectDocker, dockerEnv, dockerAdvice, dockerHelp };
