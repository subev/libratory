import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Where a phone can reach this server. A Tailscale name keeps working off Wi-Fi, so it comes
// first; a LAN address works only on the same network, and rides along as the fallback for a
// device that is on this Wi-Fi but not on the tailnet — the first code carried only the Tailscale
// name, and an iPod on the same Wi-Fi could do nothing with it.
export type Address = { origin: string; host: string; via: "tailscale" | "lan" };

export type Interface = { name?: string; address: string; family: string; internal: boolean };

// Interfaces no phone is on the other end of: VM and container bridges, tunnels, Apple's
// peer-to-peer links. This Mac offered four bridge100-103 addresses beside its one Wi-Fi address.
const VIRTUAL_INTERFACE = /^(bridge|vmnet|utun|tun|tap|docker|veth|virbr|awdl|llw|ap)\d*$|^br-/;

function isVirtual(i: Interface): boolean {
  return i.name !== undefined && VIRTUAL_INTERFACE.test(i.name);
}

// Self-assigned on a port with no DHCP: nothing a phone could reach it by
function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.");
}

function isTailnetAddress(address: string): boolean {
  // Tailscale hands out 100.64.0.0/10
  const m = /^100\.(\d+)\./.exec(address);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

// Every address a phone could use, best first: the Tailscale name (else the tailnet address, for
// a tailnet without MagicDNS), then each LAN address. Empty with nothing but loopback.
export function reachableAddresses(
  interfaces: Interface[],
  tailscaleName: string | null,
  port: number,
): Address[] {
  const external = interfaces.filter((i) => !i.internal && i.family === "IPv4");
  const address = (host: string, via: Address["via"]): Address => ({ host, origin: `http://${host}:${port}`, via });
  const tailnet = external.find((i) => isTailnetAddress(i.address));
  const list: Address[] = [];
  if (tailscaleName) list.push(address(tailscaleName, "tailscale"));
  else if (tailnet) list.push(address(tailnet.address, "tailscale"));
  for (const i of external) {
    if (isTailnetAddress(i.address) || isLinkLocal(i.address) || isVirtual(i) || list.some((a) => a.host === i.address)) continue;
    list.push(address(i.address, "lan"));
  }
  return list;
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
  return Object.entries(networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((i) => ({ ...i, name })));
}

export async function reachableAddressList(port: number): Promise<Address[]> {
  return reachableAddresses(hostInterfaces(), await tailscaleName(), port);
}
