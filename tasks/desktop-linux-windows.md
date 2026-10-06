# Desktop app on Linux, then Windows

**Paused 2026-10-06** to focus on the release: the Linux code below is committed and unit-tested,
the arm64 AppImage builds, and nothing has run on Linux yet. Pick up at "Not done" step 1.

Since BG-TTS V5 and KugelAudio were removed (2026-10-06) no engine needs a Mac: Kokoro, Piper,
BgTTS, MMS, Pocket, Marker/Surya, Tesseract, BGE-M3 and the cloud voices all run on Linux and
Windows. Two features stay Mac-only and already degrade: macOS `say` voices (the picker lists
none) and Apple Vision word boxes (Tesseract's are used). The server already runs on Linux through
`scripts/setup.sh` and the Docker image. What is Mac-only is the Electron packaging.

## Linux — the code is in, the run is not

Done on `feat/bulgarian-engines`:

- `setup.cjs`: uv from the `linux-x64` / `linux-arm64` pins (already in `scripts/pins.json`), its
  checksum computed in Node (`/usr/bin/shasum` is a macOS tool); `stageRuntime` no longer fails
  when the build ships no tessdata — the server stages eng/osd from the system tesseract.
- Tools: no tarball. A first run that is missing ffmpeg/poppler/tesseract names the command for
  the distribution (`installHint`: apt, dnf, pacman), instead of "this build is incomplete".
- `docker.cjs`: Docker Desktop for Linux's and a rootless daemon's sockets; Linux help text
  (install Docker Engine, the docker group, `systemctl start docker`) instead of "drag to
  Applications".
- `scripts/desktop-build.sh --linux` (`LINUX_ARCH=x64|arm64`): `bun-linux-*` server, edge-to-edge
  PNG icon, `electron-builder --linux AppImage`; `package.json` `build.linux`.

Not done:

1. **Build and run it on a Linux desktop.** Nothing above has run on Linux. Needs a VM or a
   machine: tart can run an Ubuntu arm64 guest on this Mac (several GB of image — ask first), and
   `LINUX_ARCH=arm64` matches it. Building the AppImage itself on the Mac downloads Electron's Linux
   build and appimagetool (~150 MB).
2. **The Electron sandbox on Ubuntu 24.04+**: AppArmor blocks unprivileged user namespaces, and an
   AppImage's Chromium then refuses to start without `--no-sandbox`. Decide between shipping an
   AppArmor profile, a `.deb` (installed sandbox helper), or documenting the flag.
3. **Release CI**: a Linux job beside the macOS one, `latest-linux.yml` for electron-updater
   (AppImage updates work; deb does not self-update).
4. **Piper and BgTTS in the desktop app** (every platform): first run builds neither
   `.venv-piper` nor `.venv-bgtts`, and `voiceMissingEngine`'s hint says `pnpm run setup`, which a
   packaged app does not have. A first-run step (Piper is small; BgTTS opt-in) or a download
   button in the picker.
5. CUDA: the lock routes Linux torch to the CPU index; a GPU build would need its own lock.

### Test bed: Omarchy on this Mac

Try Omarchy (github.com/omacom/try-omarchy, v0.5.0) is the Omarchy desktop on Arch Linux ARM in a
Hypervisor.framework VM, with a shared Mac folder and loopback port forwarding — so the arm64
AppImage (`LINUX_ARCH=arm64`) is the one to run there. Arch does not restrict user namespaces the
way Ubuntu 24.04 does, so the sandbox question above does not arise on it.

The AppImage uses electron-builder's legacy FUSE 2 runtime: a system without `libfuse.so.2`
(Arch: the `fuse2` package) cannot mount it, and `--appimage-extract-and-run` is the fallback.
Say so on the download page, or move to the static runtime when electron-builder offers it.

## Flatpak — fits as our own repository, not (yet) as Flathub

What fits: Electron apps have a base (`org.electronjs.Electron2.BaseApp`); ffmpeg, poppler and
tesseract become manifest modules, which removes the "install these from your distribution" step
the AppImage has; one package for every distribution, sandboxed, with updates through
`flatpak update`.

What does not, today:

- **Docker.** The sandbox cannot reach the host's Docker unless given its socket
  (`--filesystem=/run/docker.sock` or `xdg-run/docker.sock`), a static permission Flathub reviewers
  push back on. The clean answer is Postgres 17 + pgvector as manifest modules, run by the app as a
  child process — the bundled-Postgres path this project tried once (`tasks/desktop-app.md`) and
  dropped only because the Mac app needed Docker anyway. It would also remove Docker from the Linux
  install, which is the biggest hurdle there.
- **Flathub's build rules.** A submission must be built from source in the manifest; the
  bun-compiled server and the Python environment (torch and friends arrive as wheels, and the app
  syncs its environment with uv on first run) do not fit that. A self-hosted Flatpak repository or
  a `.flatpak` bundle has no such rule.
- **GPU**: CUDA inside a Flatpak is its own project; CPU-only is the realistic first version.

Order: AppImage first (done, needs the Linux run), then a self-hosted Flatpak with bundled
Postgres, then Flathub only if bundled Postgres has landed and the build-from-source question has
an answer.

## Windows — a note, bigger than Linux

Everything Linux needs, plus code that assumes a POSIX layout:

- **Python venv layout**: `Scripts\python.exe`, not `bin/python`. `env.ts` defaults
  (`CONDA_ENV_PATH`, `POCKET_ENV_PATH`, `PIPER_ENV_PATH`, `BGTTS_ENV_PATH`) and every
  `path.join(dir, "python")` would need a helper; same in `desktop/src/setup.cjs` `pythonBin`.
- **`zip` / `unzip`** for EPUB packaging (`lib/readaloud-epub.ts`) — not on Windows; a JS zip.
- **PATH separator** `;` in `toolPath` / `pathWithDocker`; `pgrep`/`pkill`, `/usr/bin/curl`,
  `/usr/bin/tar` in setup and main.
- **Docker**: Docker Desktop with a named pipe (`npipe:////./pipe/docker_engine`), no socket.
- **Tools**: ffmpeg, poppler and tesseract as Windows binaries (no package manager to point at;
  winget can install ffmpeg and tesseract, poppler has no official build).
- **Packaging**: NSIS target, `.ico`, `bun-windows-x64`; **code signing** or SmartScreen warns
  on every download.
- Meanwhile Windows users have the documented Docker + WSL2 route (README), which is Linux.
