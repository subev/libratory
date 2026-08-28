// The window: this file starts child processes and points a BrowserWindow at a local url.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { execFileSync, spawn } = require("node:child_process");

const path = require("node:path");
const setup = require("./setup.cjs");
const docker = require("./docker.cjs");
const crash = require("./crash.cjs");
const runtime = require("./runtime.cjs");
const updater = require("./updater.cjs");

const PORT = Number(process.env.LIBRATORY_PORT || 3034);

// Everything the app installs for itself: the Python environment, the scripts it runs, the
// lockfile it resolves against. Never inside the bundle, which an update replaces wholesale.
function defaultHome() {
  return process.env.LIBRATORY_HOME || path.join(app.getPath("appData"), "Libratory");
}

// dataDir, databaseUrl, envFile: the three things a developer running both the app and a checkout
// needs to point at one copy instead of two. The data directory is not a preference — the database
// records absolute paths to every PDF and audio file, so pointing the app at a different directory
// than wrote them gives a library that lists books it cannot play.
function readConfig(home) {
  try {
    return JSON.parse(require("node:fs").readFileSync(path.join(home, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

let HOME = null;
let RESOURCES = null;
let CONFIG = {};
const DEFAULT_DATABASE_URL = "postgres://libratory:libratory@localhost:5433/libratory";

let win = null;
let server = null;

// First run pulls a 644 MB Postgres image, which took longer than the two-minute timeout this used
// to have — killed mid-pull, and reported as "Postgres would not start". Docker's own output is
// forwarded so the wait shows progress instead of looking like a hang, and its last line survives
// into the error, because a timeout, a port already in use and a full disk are not the same problem
// and used to produce the same sentence.
function composeUp(cli, env, onOutput) {
  return new Promise((resolve) => {
    const proc = spawn(cli, ["compose", "-f", path.join(HOME, "docker-compose.yml"), "up", "-d"], { env });
    let tail = "";
    const keep = (b) => {
      const text = String(b);
      tail = (tail + text).slice(-4000);
      const line = text.trim().split("\n").filter(Boolean).at(-1);
      if (line) onOutput?.(line.slice(0, 120));
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);

    // Generous, because the only thing that takes real time here is a download on someone else's
    // connection. Still bounded, so a wedged daemon does not hang the launch forever.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      tail += "\ntimed out after 30 minutes";
    }, 30 * 60_000);

    proc.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, detail: err.message }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, detail: tail.trim().split("\n").filter(Boolean).at(-1) || `exit ${code ?? "?"}` });
    });
  });
}

// A graceful quit kills the child, but a force quit or a crash cannot — the server keeps running
// and keeps serving, so the next launch finds the port taken and the one after that talks to a
// server from two versions ago. Adopting the orphan is not worth the complexity; ending it is.
function killOrphanedServers() {
  const bundled = path.join(RESOURCES, "libratory-server");
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", bundled], { encoding: "utf8" });
    for (const pid of out.split("\n").map((n) => Number(n.trim())).filter(Boolean)) {
      if (pid !== process.pid) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  } catch {
    // pgrep exits non-zero when nothing matches, which is the common case
  }
}

function startServer(onDied) {
  killOrphanedServers();
  const bundled = path.join(RESOURCES, "libratory-server");
  server = spawn(bundled, [], { env: serverEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const keep = (b) => { tail = (tail + String(b)).slice(-2000); process.stdout.write(String(b)); };
  server.stdout?.on("data", keep);
  server.stderr?.on("data", keep);
  // Without these the common failures are invisible: a port already taken exits immediately and
  // the probe then succeeds against the *other* server, and a missing binary makes an unhandled
  // 'error' kill the main process with no window and no message.
  server.on("error", (err) => onDied(err.message));
  server.on("exit", (code, signal) => {
    if (server?.killed || signal === "SIGTERM") return;
    onDied(tail.trim().split("\n").at(-1) || `the server exited with code ${code}`);
  });
}

// Named once because the Help menu opens it too: two spellings of this precedence is how the
// menu ends up showing a folder the server is not using.
function dataDir() {
  return process.env.DATA_DIR || CONFIG.dataDir || path.join(HOME || "", "data");
}

function serverEnv() {
  return {
    ...process.env,
    LIBRATORY_HOME: HOME,
    SCRIPTS_DIR: path.join(HOME, "scripts"),
    DATA_DIR: dataDir(),
    CONDA_ENV_PATH: path.join(HOME, "python/bin"),
    POCKET_ENV_PATH: path.join(HOME, "python-pocket/bin"),
    WEB_DIR: path.join(RESOURCES, "web"),
    MIGRATIONS_DIR: path.join(RESOURCES, "drizzle"),
    DATABASE_URL: process.env.DATABASE_URL || CONFIG.databaseUrl || DEFAULT_DATABASE_URL,
    LIBRATORY_ENV_FILE: process.env.LIBRATORY_ENV_FILE || CONFIG.envFile || path.join(HOME, ".env"),
    PORT: String(PORT),
    // A GUI app's PATH omits Homebrew, and the workers spawn ffmpeg, pdftotext and pdfinfo
    PATH: setup.toolPath(RESOURCES),
  };
}

async function waitFor(url, timeoutMs, abandoned = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abandoned()) return false;
    const ok = await fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

let booting = false;

async function boot() {
  if (booting) return;
  booting = true;
  try {
    await runBoot();
  } finally {
    booting = false;
  }
}

// One list, in order, sent to the window so it can draw itself — the ids used to be written out
// again in first-run.html and agreed only by hand. A step throws to block; the runner marks the
// step that actually failed, so a Kokoro failure no longer paints its error next to "Python" and
// leaves "Kokoro voice" spinning forever.
const STEPS = [
  {
    id: "tools",
    label: "Audio and PDF tools",
    async run() {
      const missing = setup.missingTools(RESOURCES);
      if (missing.length) throw new Error(`Missing ${missing.join(", ")} from the app bundle — this build is incomplete.`);
      return "bundled";
    },
  },
  {
    id: "docker",
    label: "Docker",
    async run(ctx) {
      ctx.docker = await docker.detectDocker();
      if (ctx.docker.kind !== "ready") {
        win?.webContents.send("help", docker.dockerHelp(ctx.docker));
        throw new Error(docker.dockerAdvice(ctx.docker));
      }
      return docker.dockerAdvice(ctx.docker);
    },
  },
  {
    id: "database",
    label: "Database",
    async run(ctx, detail) {
      detail("Starting Postgres — the first run downloads a 644 MB image");
      const { ok, detail: reason } = await composeUp(ctx.docker.cli, ctx.docker.env, detail);
      if (!ok) throw new Error(`Postgres would not start: ${reason}`);
      return "Postgres on port 5433";
    },
  },
  {
    id: "python",
    label: "Python and PyTorch",
    async run(ctx, detail) {
      ctx.pending = runtime.pending(RESOURCES, HOME);
      ctx.python = setup.pythonBin(HOME);
      if (!ctx.pending.python) return "up to date";
      detail(ctx.pending.fresh ? "Installing Python and PyTorch — about 2.4 GB, once" : "Updating Python packages for this release");
      await setup.syncPython(HOME, (line) => detail(line.trim().split("\n").at(-1)));
      runtime.writeState(HOME, { pythonLock: ctx.pending.want.pythonLock });
    },
  },
  {
    id: "voice",
    label: "Kokoro voice",
    async run(ctx, detail) {
      if (!ctx.pending.models) return "up to date";
      detail("Downloading the Kokoro voice — 347 MB");
      await setup.fetchEssentialModels(ctx.python, HOME, () => {});
      runtime.writeState(HOME, { essentialModels: true });
    },
  },
  {
    id: "server",
    label: "Starting Libratory",
    async run(ctx) {
      let died = null;
      startServer((reason) => { died = reason; });
      const ready = await waitFor(`${ctx.url}/health`, 120000, () => died);
      if (died) throw new Error(died);
      if (!ready) throw new Error("The server did not start — check Console.app for Libratory.");
    },
  },
];

// The "Check again" button stays on screen while a blocked step is still blocked, which includes
// the whole of the multi-gigabyte Python step. Two of these at once means two `uv sync` runs
// against one environment and two servers racing to kill each other.
let lastFailure = null;

async function runBoot() {
  const send = (id, state, detail) => win?.webContents.send("step", { id, state, detail });
  lastFailure = null;
  win?.webContents.send("help", null);

  HOME = defaultHome();
  CONFIG = readConfig(HOME);
  RESOURCES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../resources");

  // Before any step, not inside one: the database step reads docker-compose.yml out of HOME, and
  // this is what puts it there. It used to live in the python step, three steps too late — which
  // only showed on a machine whose HOME had not already been populated by an earlier run.
  setup.stageRuntime(RESOURCES, HOME);

  const ctx = { url: `http://localhost:${PORT}` };
  for (const [i, step] of STEPS.entries()) {
    send(step.id, "running");
    try {
      send(step.id, "done", await step.run(ctx, (text) => send(step.id, "running", text)));
    } catch (err) {
      lastFailure = crash.record(err, HOME, `setup step: ${step.id}`);
      send(step.id, "blocked", String(err.message || err).slice(0, 200));
      win?.webContents.send("failed", { step: step.label });
      // Saying "skipped" beats leaving them at ○, which reads as "still to come"
      for (const later of STEPS.slice(i + 1)) send(later.id, "skipped");
      return;
    }
  }
  win.loadURL(ctx.url);
  // Only once the app is actually usable — a version check has no business delaying a launch
  updater.install({ onStatus: (text) => console.log(`[updater] ${text}`), getWindow: () => win });
}

function menu(url) {
  return Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "View",
      submenu: [
        // The app is a local server and a page, so any browser works — and this is the way out if
        // the embedded webview ever renders something badly.
        { label: "Open in your browser", accelerator: "CmdOrCtrl+Shift+O", click: () => shell.openExternal(url) },
        { type: "separator" },
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Show data folder", click: () => shell.openPath(dataDir()) },
        { label: "Check for Updates…", click: () => void updater.checkNow() },
        { label: "Where things live", click: () => dialog.showMessageBox({ message: `Everything the app installed: ${HOME}\nYour library: Postgres in Docker, port 5433\nServer: ${url}\nUpdates: ${updater.updatesConfigured() ? "from GitHub releases" : "not configured — this is a local build"}` }) },
        { type: "separator" },
        { label: "Report a problem", click: () => shell.openExternal(`${crash.REPO}/issues/new`) },
        { label: "Open the crash log", click: () => shell.openPath(crash.logPath(HOME || "")) },
      ],
    },
    { role: "windowMenu" },
  ]);
}

crash.install(() => HOME || defaultHome());

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 860, title: "Libratory",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  // The UI links out to Hacker News, publisher pages and whatever a digest cites. Electron's
  // default would open those in a chrome-less window that inherits this preload — an arbitrary
  // site with no address bar and `window.setup.recheck` on it. Send them to the real browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`http://localhost:${PORT}`) && !target.startsWith("file://")) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  Menu.setApplicationMenu(menu(`http://localhost:${PORT}`));
  win.loadFile(path.join(__dirname, "first-run.html"));
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("steps", STEPS.map(({ id, label }) => ({ id, label })));
    void boot();
  });
  ipcMain.on("recheck", boot);
  ipcMain.on("open", (_e, url) => void shell.openExternal(url));
  ipcMain.on("report", () => {
    if (lastFailure) crash.show(lastFailure);
  });

});

app.on("window-all-closed", () => {
  server?.kill();
  app.quit();
});
app.on("before-quit", () => server?.kill());
