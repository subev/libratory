import { existsSync } from "node:fs";
import path from "node:path";

import { env } from "../env.ts";
import { DownloadTracker } from "./downloads.ts";
import { scriptPath } from "./paths.ts";

// BgTTS is the one engine the app builds for itself: Piper is built by the desktop first run and
// the Docker image, while BgTTS's own torch (~1.5 GB) is too much to impose on every install. The
// venv is read on every synthesis and every engines probe, so a finished install is live at once.
export type EngineInstallState = {
  /** A uv to build with, and a runtime where the venv outlives the process — not a container. */
  installable: boolean;
  installing: boolean;
  /** The step the install is on, e.g. "PyTorch and audio libraries — about 1 GB". */
  progress: string | null;
  error: string | null;
};

const installs = new DownloadTracker();

export function bgttsInstallState(): EngineInstallState {
  return {
    installable: env.LIBRATORY_RUNTIME !== "docker" && existsSync(env.UV_PATH),
    installing: installs.downloading("bgtts"),
    progress: installs.progressOf("bgtts"),
    error: installs.error("bgtts"),
  };
}

export function startBgttsInstall(): { started: boolean } {
  if (!bgttsInstallState().installable) {
    throw new Error(env.LIBRATORY_RUNTIME === "docker" ? "BgTTS is not in the Docker image" : `No uv at ${env.UV_PATH} — run pnpm run setup --bgtts`);
  }
  return installs.start("bgtts", "/bin/sh", [
    scriptPath("install_bgtts.sh"),
    env.UV_PATH,
    path.dirname(env.BGTTS_ENV_PATH),
    env.SCRIPTS_DIR,
  ]);
}
