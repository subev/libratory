import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Where a phone can reach this server. A Tailscale name keeps working off Wi-Fi, so it wins; the
// LAN address is the fallback that works only on the same network, and the page says so.
export type Reachable = { origin: string; host: string; via: "tailscale" | "lan" } | null;

export type Interface = { address: string; family: string; internal: boolean };

function isTailnetAddress(address: string): boolean {
  // Tailscale hands out 100.64.0.0/10
  const m = /^100\.(\d+)\./.exec(address);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

export function pickReachable(
  interfaces: Interface[],
  tailscaleName: string | null,
  port: number,
): Reachable {
  const external = interfaces.filter((i) => !i.internal && i.family === "IPv4");
  const tailnet = external.find((i) => isTailnetAddress(i.address));
  const host = tailscaleName ?? tailnet?.address ?? external.find((i) => !isTailnetAddress(i.address))?.address;
  if (!host) return null;
  const via = tailscaleName || tailnet ? "tailscale" : "lan";
  return { host, origin: `http://${host}:${port}`, via };
}

// The MagicDNS name, from the CLI when it is there. Finder-launched apps get no PATH worth the
// name, so the known install locations are tried by path first.
const TAILSCALE_BINARIES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
  "tailscale",
];

export async function tailscaleName(): Promise<string | null> {
  for (const bin of TAILSCALE_BINARIES) {
    try {
      const { stdout } = await execFileAsync(bin, ["status", "--json"], { timeout: 3_000 });
      const status: unknown = JSON.parse(stdout);
      const name = dnsNameOf(status);
      if (name) return name;
    } catch {
      continue;
    }
  }
  return null;
}

function dnsNameOf(status: unknown): string | null {
  if (typeof status !== "object" || status === null) return null;
  const self = (status as { Self?: unknown }).Self;
  if (typeof self !== "object" || self === null) return null;
  const online = (self as { Online?: unknown }).Online;
  const dnsName = (self as { DNSName?: unknown }).DNSName;
  if (online === false || typeof dnsName !== "string" || dnsName.length === 0) return null;
  return dnsName.replace(/\.$/, "");
}

function hostInterfaces(): Interface[] {
  return Object.values(networkInterfaces()).flatMap((list) => list ?? []);
}

export async function reachableAddress(port: number): Promise<Reachable> {
  return pickReachable(hostInterfaces(), await tailscaleName(), port);
}
