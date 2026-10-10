import { access } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.ts";
import { books, devices, documents, profiles, shelfDownloads, shelfFetches } from "./schema.ts";
import { isUuid } from "./lib/uuid.ts";
import { outputDir } from "./lib/paths.ts";
import { PAIR_RATE_LIMIT, SHELF_RATE_LIMIT } from "./lib/request-limits.ts";
import { pairingTokens } from "./lib/pairing.ts";
import { machineName, shelfAddresses } from "./lib/shelf-address.ts";
import { groupByBook, hashDeviceKey, newDeviceKey, publicShelfProfileId, shelfBookCount, shelfDocuments } from "./lib/shelf.ts";
import { contentDisposition } from "./lib/content-disposition.ts";

// The only surface a phone can reach, and it is read-only: list a profile's finished shelf, fetch
// a cover, download a file. The device key is the whole credential — no cookie is ever read here,
// so a page in a browser cannot ride a session into it, and the destructive tRPC API stays exactly
// as unexposed as before. Contract in docs/shelf.md.

const pairBody = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
});

async function profileNamed(profileId: string): Promise<{ id: string; name: string } | undefined> {
  const [profile] = await db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(eq(profiles.id, profileId));
  return profile;
}

type Device = typeof devices.$inferSelect;
// Who is asking: a paired device, or anyone at all when a profile's shelf is public
type Caller = { profileId: string; device: Device | null };

// A credential that is offered has to be a device key this server issued; only a request that
// offers none at all is the public
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const key = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const [device] = key ? await db.select().from(devices).where(eq(devices.keyHash, hashDeviceKey(key))) : [];
    if (device) {
      await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
      return { profileId: device.profileId, device };
    }
  } else {
    const publicProfile = publicShelfProfileId();
    if (publicProfile) return { profileId: publicProfile, device: null };
  }
  await reply.code(401).send({ error: "This shelf does not know this phone" });
  return null;
}

// A download is counted once, when the file is asked for from its start; a resumed range or a
// HEAD that only sizes it is the same download continuing
function startsDownload(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false;
  const range = request.headers.range;
  return range === undefined || range.startsWith("bytes=0-");
}

// The proxy may say where a request came from (Cloudflare's CF-IPCountry); nothing else is kept
function countryOf(request: FastifyRequest): string | null {
  const value = request.headers["cf-ipcountry"];
  return typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null;
}

export function registerShelfRoutes(fastify: FastifyInstance) {
  fastify.get("/shelf/pair/:token", { config: { rateLimit: PAIR_RATE_LIMIT } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const peek = pairingTokens.peek(token);
    if (peek === "unknown") return reply.code(404).send({ error: "Unknown pairing code" });
    if (peek === "gone") return reply.code(410).send({ error: "This pairing code has been used or has expired" });
    const profile = await profileNamed(peek.profileId);
    if (!profile) return reply.code(404).send({ error: "Unknown pairing code" });
    const addresses = await shelfAddresses();
    return {
      machine: machineName(),
      profile,
      bookCount: await shelfBookCount(profile.id),
      via: addresses[0]?.via ?? "lan",
      // Every way to this server, best first, so a reader can fall back from the Tailscale name
      // to the LAN address when it is on the same Wi-Fi and not on the tailnet
      addresses: addresses.map(({ origin, via }) => ({ origin, via })),
      expiresAt: peek.expiresAt.toISOString(),
    };
  });

  fastify.post("/shelf/pair", { config: { rateLimit: PAIR_RATE_LIMIT } }, async (request, reply) => {
    const parsed = pairBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "token and name are required" });
    const spent = pairingTokens.spend(parsed.data.token);
    if (spent === "unknown") return reply.code(404).send({ error: "Unknown pairing code" });
    if (spent === "gone") return reply.code(410).send({ error: "This pairing code has been used or has expired" });
    const profile = await profileNamed(spent.profileId);
    if (!profile) return reply.code(404).send({ error: "Unknown pairing code" });

    const deviceKey = newDeviceKey();
    const [device] = await db
      .insert(devices)
      .values({ profileId: profile.id, name: parsed.data.name, keyHash: hashDeviceKey(deviceKey) })
      .returning({ id: devices.id });
    if (!device) throw new Error("Failed to pair the phone");
    return {
      deviceId: device.id,
      deviceKey,
      machine: machineName(),
      profile,
      bookCount: await shelfBookCount(profile.id),
      addresses: (await shelfAddresses()).map(({ origin, via }) => ({ origin, via })),
    };
  });

  fastify.get("/shelf", { config: { rateLimit: SHELF_RATE_LIMIT } }, async (request, reply) => {
    const caller = await authenticate(request, reply);
    if (!caller) return;
    const profile = await profileNamed(caller.profileId);
    if (!profile) return reply.code(401).send({ error: "This shelf is gone" });
    const docs = await shelfDocuments(profile.id, { includeHidden: false });
    return {
      machine: machineName(),
      profile,
      public: caller.device === null,
      device: caller.device ? { id: caller.device.id, name: caller.device.name } : null,
      books: groupByBook(docs, caller.device?.id ?? null),
    };
  });

  fastify.get("/shelf/documents/:documentId", { config: { rateLimit: SHELF_RATE_LIMIT } }, async (request, reply) => {
    const caller = await authenticate(request, reply);
    if (!caller) return;
    const { documentId } = request.params as { documentId: string };
    if (!isUuid(documentId)) return reply.code(400).send({ error: "Invalid document id" });
    const [row] = await db
      .select({ outputPath: documents.outputPath, format: documents.format, hidden: documents.shelfHidden, profileId: books.profileId })
      .from(documents)
      .innerJoin(books, eq(documents.bookId, books.id))
      .where(eq(documents.id, documentId));
    const onShelf = row && row.profileId === caller.profileId && !row.hidden && (row.format === "epub-sync" || row.format === "epub-bilingual");
    if (!onShelf) return reply.code(404).send({ error: "Not on this shelf" });

    // Recorded only once the file is known to be there: a missing file must not show as "on phones"
    const present = await access(row.outputPath).then(() => true, () => false);
    if (!present) return reply.code(404).send({ error: "The file is missing on the server" });
    if (caller.device) {
      await db.insert(shelfDownloads).values({ deviceId: caller.device.id, documentId }).onConflictDoNothing();
    } else if (startsDownload(request)) {
      const userAgent = request.headers["user-agent"];
      await db.insert(shelfFetches).values({ documentId, userAgent: typeof userAgent === "string" ? userAgent.slice(0, 200) : null, country: countryOf(request) });
    }
    return reply
      .type("application/epub+zip")
      .header("content-disposition", contentDisposition("attachment", path.basename(row.outputPath)))
      .sendFile(path.relative(outputDir, row.outputPath), outputDir);
  });

}
