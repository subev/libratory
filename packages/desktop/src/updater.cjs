const { app, dialog, shell } = require("electron");
const { existsSync } = require("node:fs");
const path = require("node:path");

// Checked in the background after the window is up, never during boot: an update that delays the
// app opening is worse than an update that waits for the next launch. The runtime steps
// (runtime.cjs) then bring Python and the models forward on that next launch, which is why a
// restart is offered rather than a silent swap.
//
// Nothing is pushed to us — every check is a GET of latest-mac.yml. Once per launch is not enough
// for an app people leave open for days at a time, so it also repeats; declining a version stops
// it asking about that version again until the app restarts.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/subev/libratory/releases";

// Help → Check for Updates. The default is the honest answer for a build with no feed, because
// install() returns early in precisely that case and would never get to replace this.
let checkNow = async () => {
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "Updates are not available in this build",
    message: `Libratory ${app.getVersion()} was built locally.`,
    detail: "Builds made with `pnpm app` carry no update feed, so this copy will never find a new version however long it runs. Install a release from GitHub to get updates.",
    buttons: ["Open the downloads page", "OK"],
    defaultId: 1,
    noLink: true,
  });
  if (response === 0) void shell.openExternal(`${RELEASES_URL}/latest`);
};
// `pnpm app` builds with --dir, which skips app-update.yml, so a locally-installed copy can never
// find an update — and used to say nothing at all, which is indistinguishable from being current.
function updatesConfigured() {
  return app.isPackaged && existsSync(path.join(process.resourcesPath, "app-update.yml"));
}

let installed = false;

/**
 * @param {{ onStatus?: (text: string) => void, getWindow?: () => import("electron").BrowserWindow | null }} [opts]
 */
function install({ onStatus, getWindow } = {}) {
  // boot() runs again on "recheck", and every listener below would be registered a second time —
  // two dialogs for one update, and an interval nothing clears.
  if (installed) return;
  installed = true;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return; // not packaged with an updater, e.g. a dev run
  }

  // electron-updater's own account of what it decided, which is the only way to tell "no update"
  // apart from "could not reach the feed" apart from "refused the signature".
  autoUpdater.logger = { info: onStatus ?? (() => {}), warn: onStatus ?? (() => {}), error: onStatus ?? (() => {}), debug: () => {} };

  // We ship the DMG and let people decide; a background download that then demands a restart is
  // the behaviour everyone complains about.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let downloaded = null;
  const declined = new Set();

  // Decimal, because that is what Finder and the GitHub release page both say.
  const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
  // getWindow returns main.cjs's `win`, which is not cleared when the window closes — calling
  // setProgressBar on a destroyed one throws from inside an event handler and crashes on quit.
  const progress = (fraction) => {
    const win = getWindow?.();
    if (win && !win.isDestroyed()) win.setProgressBar(fraction);
  };

  autoUpdater.on("update-available", async (info) => {
    if (declined.has(info.version)) return;
    const size = info.files?.[0]?.size ? mb(info.files[0].size) : null;
    onStatus?.(`Update available: ${info.version}${size ? ` (${size})` : ""}`);
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "A new Libratory is available",
      message: `Version ${info.version} is ready to download.`,
      detail: `${size ? `About ${size} to download. ` : ""}It installs when you quit, and the next launch brings the Python environment and models up to date with it. Nothing in your library changes.`,
      buttons: ["Download it", "Not now"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await autoUpdater.downloadUpdate();
    else declined.add(info.version);
  });

  // The Dock icon rather than a dialog: Electron dialogs cannot be updated once shown, and a
  // modal would block the app for the length of a 190 MB download.
  autoUpdater.on("download-progress", ({ percent, transferred, total }) => {
    progress(percent / 100);
    onStatus?.(`Downloading ${Math.round(percent)}% — ${mb(transferred)} of ${mb(total)}`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    progress(-1);
    downloaded = info.version;
    onStatus?.(`Update ${info.version} downloaded`);
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Ready to install",
      message: `Libratory ${info.version} is ready.`,
      detail: "Restarting takes a few seconds. If this release changes the Python environment, the next launch will say so while it catches up.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      // The server child is killed by before-quit; quitAndInstall runs after that
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    progress(-1);
    onStatus?.(`Updater error: ${err.message}`);
    // A failed *check* must never reach the user: they did not ask, and there is nothing to do
    // about it. A failed *install* is different — they clicked twice and are waiting for a restart
    // that will not come, and the manual download does work.
    if (!downloaded) return;
    const signature = /code signature|did not pass validation/i.test(err.message);
    void dialog.showMessageBox({
      type: "warning",
      title: "That update could not install itself",
      message: `Libratory ${downloaded} downloaded, but macOS would not let it replace the running app.`,
      detail: signature
        ? "This build is not signed by an Apple developer certificate, and macOS only lets signed apps update themselves. Downloading the new version and dragging it to Applications works — it is the same file."
        : err.message,
      buttons: ["Open the downloads page", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) void shell.openExternal(`${RELEASES_URL}/latest`);
    });
  });

  if (!updatesConfigured()) {
    onStatus?.("No app-update.yml — this build cannot check for updates");
    return;
  }
  // The launch check used to throw its failure away and not try again for six hours, so a network
  // that was not ready yet — while Docker, Postgres and Python are still coming up — meant no
  // update was offered across restart after restart, until the Help menu asked and it worked.
  const RETRY_AFTER_MS = [15_000, 60_000, 300_000];
  const pendingRetries = new Set();
  const check = (attempt = 0) => {
    autoUpdater.checkForUpdates().catch((err) => {
      const again = RETRY_AFTER_MS[attempt];
      onStatus?.(`Update check failed: ${err.message}${again ? ` — trying again in ${again / 1000}s` : " — waiting for the next scheduled check"}`);
      if (!again) return;
      const retry = setTimeout(() => {
        pendingRetries.delete(retry);
        check(attempt + 1);
      }, again);
      pendingRetries.add(retry);
    });
  };
  check();
  const timer = setInterval(() => check(), CHECK_EVERY_MS);
  app.on("before-quit", () => {
    clearInterval(timer);
    for (const retry of pendingRetries) clearTimeout(retry);
  });

  // Asked for from the Help menu. The automatic check is deliberately quiet about finding nothing,
  // which leaves no way to tell "already current" from "never looked" — this answers both.
  checkNow = async () => {
    // Asking explicitly overrides a "Not now" from earlier in this session
    declined.clear();
    const result = await autoUpdater.checkForUpdates().catch((err) => {
      void dialog.showMessageBox({
        type: "warning",
        message: "Could not check for updates.",
        detail: err.message,
        buttons: ["OK"],
      });
      return null;
    });
    // An available update opens its own dialog through the event above; silence is the only
    // outcome that needs answering here.
    if (result && !result.isUpdateAvailable) {
      void dialog.showMessageBox({
        type: "info",
        message: `Libratory ${app.getVersion()} is the latest version.`,
        buttons: ["OK"],
      });
    }
  };

}

// checkNow is reassigned by install(), so the export has to read it at call time rather than
// capture the placeholder defined above.
module.exports = { install, updatesConfigured, checkNow: () => checkNow() };
