import net from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env, envFilePath } from "../env.ts";
import { updateEnvFile } from "./env-file.ts";

// What an address other than this machine's own may reach. HOST=0.0.0.0 binds the network, and
// this is what decides what the network then gets: nothing, the phone shelf, or everything. The
// library has no login, so "everything" is for a server that sits behind one of its own — which is
// what a Docker install is, and why it defaults there. A laptop defaults to nothing: a hotel Wi-Fi
// sees an open port that answers 403, and a shelf is shared from the Phone page, not by rebinding.
export const NETWORK_ACCESS = ["none", "shelf", "all"] as const;
export type NetworkAccess = (typeof NETWORK_ACCESS)[number];

export function currentNetworkAccess(): NetworkAccess {
  return env.NETWORK_ACCESS ?? (env.LIBRATORY_RUNTIME === "docker" ? "all" : "none");
}

// Applied in memory too, so sharing a shelf never needs a restart
export function setNetworkAccess(access: NetworkAccess): void {
  updateEnvFile(envFilePath, "NETWORK_ACCESS", access);
  env.NETWORK_ACCESS = access;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  switch (net.isIP(bare)) {
    case 4:
      return bare.startsWith("127.");
    case 6:
      return bare === "::1";
    default:
      return false;
  }
}

// The decision is made on the *matched route*, never on the URL as typed: `/shelf/../trpc`,
// `/SHELF/x` and an encoded slash all match no shelf route and land here with no route at all,
// which is refused. Only the four routes registered under /shelf answer the network.
export function networkMayReach(access: NetworkAccess, remoteAddress: string | undefined, routeUrl: string | undefined): boolean {
  if (isLoopbackAddress(remoteAddress)) return true;
  switch (access) {
    case "all":
      return true;
    case "shelf":
      return routeUrl !== undefined && (routeUrl === "/shelf" || routeUrl.startsWith("/shelf/"));
    case "none":
      return false;
    default: {
      const unhandled: never = access;
      throw new Error(`unhandled network access ${unhandled}`);
    }
  }
}

function remoteAddressOf(request: FastifyRequest): string | undefined {
  // The socket, not request.ip: a forwarded header is whatever the sender wrote
  return request.socket.remoteAddress;
}

// First hook on the server, before CORS and every plugin, so a refused request never reaches
// anything that could answer it — not even a preflight.
export function registerNetworkAccessGuard(fastify: FastifyInstance, access: () => NetworkAccess = currentNetworkAccess) {
  fastify.addHook("onRequest", async (request, reply) => {
    if (networkMayReach(access(), remoteAddressOf(request), request.routeOptions.url)) return;
    return reply.code(403).send({ error: "Not reachable from the network" });
  });
}
