import os from "node:os";
import { env } from "../env.ts";
import { reachableAddressList } from "./reachable-address.ts";

export type ShelfAddress = { origin: string; host: string; via: "tailscale" | "lan" | "internet" };

function publicOrigin(): URL | null {
  if (!env.PUBLIC_ORIGIN) return null;
  try {
    return new URL(env.PUBLIC_ORIGIN);
  } catch {
    return null;
  }
}

// Where a phone reaches the shelf, best first. A public name is the one address when configured —
// behind a proxy the interfaces say nothing about the world's view — else whatever the machine's
// own network offers: Tailscale first, then the LAN addresses a device on the same Wi-Fi can use.
export async function shelfAddresses(): Promise<ShelfAddress[]> {
  const url = publicOrigin();
  if (url) return [{ origin: url.origin, host: url.host, via: "internet" }];
  return reachableAddressList(env.PORT);
}

// What groups shelves on the reader: the host the world knows, or this machine's name. Under a
// proxy the hostname is a container id, which groups nothing.
export function machineName(): string {
  return publicOrigin()?.hostname ?? os.hostname();
}
