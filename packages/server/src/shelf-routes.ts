import os from "node:os";
import { access } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { books, devices, documents, profiles, shelfDownloads } from "./schema.ts";
import { isUuid } from "./lib/uuid.ts";
import { outputDir } from "./lib/paths.ts";
import { PAIR_RATE_LIMIT } from "./lib/request-limits.ts";
import { pairingTokens } from "./lib/pairing.ts";
import { reachableAddress } from "./lib/reachable-address.ts";
import { groupByBook, hashDeviceKey, newDeviceKey, shelfBookCount, shelfDocuments } from "./lib/shelf.ts";
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

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Device | null> {
  const header = request.headers.authorization;
  const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const device = key ? (await db.select().from(devices).where(eq(devices.keyHash, hashDeviceKey(key))))[0] : undefined;
  if (!device) {
    await reply.code(401).send({ error: "This shelf does not know this phone" });
    return null;
  }
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));
  return device;
}

export function registerShelfRoutes(fastify: FastifyInstance) {
  fastify.get("/shelf/pair/:token", { config: { rateLimit: PAIR_RATE_LIMIT } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const peek = pairingTokens.peek(token);
    if (peek === "unknown") return reply.code(404).send({ error: "Unknown pairing code" });
    if (peek === "gone") return reply.code(410).send({ error: "This pairing code has been used or has expired" });
    const profile = await profileNamed(peek.profileId);
    if (!profile) return reply.code(404).send({ error: "Unknown pairing code" });
    const reachable = await reachableAddress(env.PORT);
    return {
      machine: os.hostname(),
      profile,
      bookCount: await shelfBookCount(profile.id),
      via: reachable?.via ?? "lan",
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
      machine: os.hostname(),
      profile,
      bookCount: await shelfBookCount(profile.id),
    };
  });

  fastify.get("/shelf", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (!device) return;
    const profile = await profileNamed(device.profileId);
    if (!profile) return reply.code(401).send({ error: "This shelf is gone" });
    const docs = await shelfDocuments(profile.id, { includeHidden: false });
    return {
      machine: os.hostname(),
      profile,
      device: { id: device.id, name: device.name },
      books: groupByBook(docs, device.id),
    };
  });

  fastify.get("/shelf/documents/:documentId", async (request, reply) => {
    const device = await authenticate(request, reply);
    if (!device) return;
    const { documentId } = request.params as { documentId: string };
    if (!isUuid(documentId)) return reply.code(400).send({ error: "Invalid document id" });
    const [row] = await db
      .select({ outputPath: documents.outputPath, format: documents.format, hidden: documents.shelfHidden, profileId: books.profileId })
      .from(documents)
      .innerJoin(books, eq(documents.bookId, books.id))
      .where(eq(documents.id, documentId));
    const onShelf = row && row.profileId === device.profileId && !row.hidden && (row.format === "epub-sync" || row.format === "epub-bilingual");
    if (!onShelf) return reply.code(404).send({ error: "Not on this shelf" });

    // Recorded only once the file is known to be there: a missing file must not show as "on phones"
    const present = await access(row.outputPath).then(() => true, () => false);
    if (!present) return reply.code(404).send({ error: "The file is missing on the server" });
    await db.insert(shelfDownloads).values({ deviceId: device.id, documentId }).onConflictDoNothing();
    return reply
      .type("application/epub+zip")
      .header("content-disposition", contentDisposition("attachment", path.basename(row.outputPath)))
      .sendFile(path.relative(outputDir, row.outputPath), outputDir);
  });

}
