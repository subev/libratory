import { existsSync } from "node:fs";
import path from "node:path";

import { env } from "../env.ts";
import { DownloadTracker } from "./downloads.ts";
import { scriptPath } from "./paths.ts";

// The engines the app builds for itself: Piper is built by the desktop first run and the Docker
// image, while BgTTS's and loudkit's own torch (~1.5 GB each with their models) is too much to
// impose on every install. The venv is read on every synthesis and every engines probe, so a
// finished install is live at once.
export type EngineInstallState = {
  /** A uv to build with, and a runtime where the venv outlives the process — not a container. */
  installable: boolean;
  installing: boolean;
  /** The step the install is on, e.g. "PyTorch and audio libraries — about 1 GB". */
  progress: string | null;
  error: string | null;
};

export const INSTALLABLE_ENGINES = ["bgtts", "loudkit"] as const;
export type InstallableEngine = (typeof INSTALLABLE_ENGINES)[number];

const RECIPES: Record<InstallableEngine, { label: string; script: string; envPath: () => string }> = {
  bgtts: { label: "BgTTS", script: "install_bgtts.sh", envPath: () => env.BGTTS_ENV_PATH },
  loudkit: { label: "loudkit", script: "install_loudkit.sh", envPath: () => env.LOUDKIT_ENV_PATH },
};

const installs = new DownloadTracker();

export function engineInstallState(engine: InstallableEngine): EngineInstallState {
  return {
    installable: env.LIBRATORY_RUNTIME !== "docker" && existsSync(env.UV_PATH),
    installing: installs.downloading(engine),
    progress: installs.progressOf(engine),
    error: installs.error(engine),
  };
}

export function startEngineInstall(engine: InstallableEngine): { started: boolean } {
  const recipe = RECIPES[engine];
  if (!engineInstallState(engine).installable) {
    throw new Error(env.LIBRATORY_RUNTIME === "docker" ? `${recipe.label} is not in the Docker image` : `No uv at ${env.UV_PATH} — run pnpm run setup`);
  }
  return installs.start(engine, "/bin/sh", [
    scriptPath(recipe.script),
    env.UV_PATH,
    path.dirname(recipe.envPath()),
    env.SCRIPTS_DIR,
  ]);
}
