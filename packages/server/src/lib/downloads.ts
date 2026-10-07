import { spawn } from "node:child_process";

// The bookkeeping behind every optional download: which are running, and why the last one failed.
// Model bundles and Pocket's per-language models had a copy each, which is how one of them gained
// a fix for spawn errors reporting as "exit ?" and the other kept reporting "exit ?".
export class DownloadTracker {
  private readonly inFlight = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly progress = new Map<string, string>();

  get active(): number {
    return this.inFlight.size;
  }

  downloading(id: string): boolean {
    return this.inFlight.has(id);
  }

  error(id: string): string | null {
    return this.failures.get(id) ?? null;
  }

  // "2.1 / 5.0 GB (42%)" — five gigabytes behind the word "Downloading…" and nothing else is the
  // kind of wait people give up on, because there is no way to tell it apart from a hang.
  progressOf(id: string): string | null {
    return this.progress.get(id) ?? null;
  }

  // HF_HUB_OFFLINE is deliberately 0 here — this is the one path allowed to reach the network.
  start(id: string, bin: string, args: string[], onDone?: () => void): { started: boolean } {
    if (this.inFlight.has(id)) return { started: false };
    this.inFlight.add(id);
    this.failures.delete(id);

    const proc = spawn(bin, args, { env: { ...process.env, HF_HUB_OFFLINE: "0" } });
    let stderr = "";
    proc.stderr?.on("data", (buf) => { stderr = (stderr + String(buf)).slice(-2000); });
    proc.stdout?.on("data", (buf) => {
      for (const line of String(buf).split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const m = JSON.parse(line) as { type?: string; mb?: number; totalMb?: number; label?: string };
          // A multi-step install (lib/engine-install.ts) names the step it is on instead
          if (m.type === "step" && m.label) {
            this.progress.set(id, m.label);
            continue;
          }
          if (m.type !== "progress" || m.mb === undefined || !m.totalMb) continue;
          const pct = Math.min(99, Math.round((m.mb / m.totalMb) * 100));
          this.progress.set(id, `${(m.mb / 1024).toFixed(1)} / ${(m.totalMb / 1024).toFixed(1)} GB (${pct}%)`);
        } catch {
          // A line that is not our JSON is the library talking to itself; not worth reacting to
        }
      }
    });

    // A failed spawn emits "error" and then "close" with an empty stderr, so without the guard the
    // useful message ("spawn …/python ENOENT") is overwritten by a generic "exit ?".
    let settled = false;
    const finish = (message: string | null) => {
      if (settled) return;
      settled = true;
      this.inFlight.delete(id);
      this.progress.delete(id);
      if (message) this.failures.set(id, message);
      onDone?.();
    };
    proc.on("close", (code) => finish(code === 0 ? null : stderr.trim().split("\n").at(-1) || `Download failed (exit ${code ?? "?"})`));
    proc.on("error", (err) => finish(err.message));

    return { started: true };
  }
}
