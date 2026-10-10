import os from "node:os";
import { env } from "../env.ts";
import { reachableAddress } from "./reachable-address.ts";

export type ShelfAddress = { origin: string; host: string; via: "tailscale" | "lan" | "internet" };

function publicOrigin(): URL | null {
  if (!env.PUBLIC_ORIGIN) return null;
  try {
    return new URL(env.PUBLIC_ORIGIN);
  } catch {
    return null;
  }
}

// Where a phone reaches the shelf. A public name wins when one is configured — behind a proxy
// the interfaces say nothing about the world's view — else whatever the machine's own network
// offers, Tailscale first.
export async function shelfAddress(): Promise<ShelfAddress | null> {
  const url = publicOrigin();
  if (url) return { origin: url.origin, host: url.host, via: "internet" };
  return reachableAddress(env.PORT);
}

// What groups shelves on the reader: the host the world knows, or this machine's name. Under a
// proxy the hostname is a container id, which groups nothing.
export function machineName(): string {
  return publicOrigin()?.hostname ?? os.hostname();
}
