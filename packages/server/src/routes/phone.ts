import { and, countDistinct, desc, eq, inArray } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { db } from "../db.ts";
import { env, envFilePath } from "../env.ts";
import { router, publicProcedure } from "../trpc.ts";
import { books, devices, documents, profiles, shelfDownloads, DEFAULT_PROFILE_ID } from "../schema.ts";
import { updateEnvFile } from "../lib/env-file.ts";
import { PAIRING_TTL_MS, pairLink, pairingTokens } from "../lib/pairing.ts";
import { machineName, shelfAddress } from "../lib/shelf-address.ts";
import { publicShelfProfileId, setPublicShelfProfile, shelfDocuments } from "../lib/shelf.ts";
import { NETWORK_ACCESS, currentNetworkAccess, setNetworkAccess } from "../lib/network-access.ts";

// The workshop's Phone page: a code that adds the current profile's shelf to a phone, the phones
// already on it, and what they see. Everything here is scoped to the caller's profile, because a
// shelf is a profile — two people on one machine pair to two shelves.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export const phoneRouter = router({
  // Mints a fresh code on every read; the page refetches when the old one dies. No code while the
  // network cannot reach the shelf — a code that no phone can use would be a trap.
  pairingCode: publicProcedure.query(async ({ ctx }) => {
    const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
    const [profile] = await db.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, profileId));
    const reachable = await shelfAddress();
    // A public name is reached through a proxy, which may well forward to loopback
    const loopbackOnly = LOOPBACK.has(env.HOST) && reachable?.via !== "internet";
    const access = currentNetworkAccess();
    const isPublic = publicShelfProfileId() === profileId;
    const base = { profileName: profile?.name ?? "Default", machine: machineName(), reachable, loopbackOnly, access, isPublic };
    if (!reachable || loopbackOnly || access === "none") return { ...base, code: null };
    const { token, expiresAt } = pairingTokens.mint(profileId);
    const link = pairLink(env.PAIR_LINK_BASE, reachable.origin, token);
    // The quiet zone is part of the image, so the page needs no white ground of its own
    const svg = await QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    return {
      ...base,
      code: {
        link,
        image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        expiresAt: expiresAt.toISOString(),
        // The page counts down from this, not from expiresAt: a browser clock ten minutes ahead
        // would see every fresh code as dead and mint forever
        expiresInMs: PAIRING_TTL_MS,
      },
    };
  }),

  // Writes HOST=0.0.0.0 — the server binds at boot, so this takes a restart to apply. Binding alone
  // exposes nothing: what the network may then reach is `setNetworkAccess`, which defaults to none.
  listenOnNetwork: publicProcedure.mutation(() => {
    updateEnvFile(envFilePath, "HOST", "0.0.0.0");
    return { restartNeeded: true };
  }),

  // One profile's shelf answers the world with no pairing: the public case. Off clears it.
  setPublic: publicProcedure
    .input(z.object({ public: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      if (input.public) setPublicShelfProfile(profileId);
      else if (publicShelfProfileId() === profileId) setPublicShelfProfile(null);
      return { public: publicShelfProfileId() === profileId };
    }),

  // Live: the guard reads the setting per request, so sharing starts and stops with no restart
  setNetworkAccess: publicProcedure
    .input(z.object({ access: z.enum(NETWORK_ACCESS) }))
    .mutation(({ input }) => {
      setNetworkAccess(input.access);
      return { access: input.access };
    }),

  devices: publicProcedure.query(async ({ ctx }) => {
    const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
    const rows = await db
      .select({ id: devices.id, name: devices.name, pairedAt: devices.pairedAt, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.profileId, profileId))
      .orderBy(desc(devices.lastSeenAt));
    if (rows.length === 0) return [];
    // Books, not files: a phone that fetched both editions of one book has one book
    const counts = await db
      .select({ deviceId: shelfDownloads.deviceId, n: countDistinct(documents.bookId) })
      .from(shelfDownloads)
      .innerJoin(documents, eq(shelfDownloads.documentId, documents.id))
      .where(inArray(shelfDownloads.deviceId, rows.map((r) => r.id)))
      .groupBy(shelfDownloads.deviceId);
    const booksOn = new Map(counts.map((c) => [c.deviceId, c.n]));
    return rows.map((r) => ({ ...r, books: booksOn.get(r.id) ?? 0 }));
  }),

  forget: publicProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const deleted = await db.delete(devices).where(and(eq(devices.id, input.id), eq(devices.profileId, profileId))).returning({ id: devices.id });
      if (deleted.length === 0) throw new Error("Phone not found");
      return { success: true };
    }),

  shelf: publicProcedure.query(async ({ ctx }) => {
    const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
    return shelfDocuments(profileId, { includeHidden: true });
  }),

  setHidden: publicProcedure
    .input(z.object({ documentId: z.uuid(), hidden: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const profileId = ctx.profileId ?? DEFAULT_PROFILE_ID;
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(books, eq(documents.bookId, books.id))
        .where(and(eq(documents.id, input.documentId), eq(books.profileId, profileId)));
      if (!row) throw new Error("Document not found");
      await db.update(documents).set({ shelfHidden: input.hidden }).where(eq(documents.id, row.id));
      return { success: true };
    }),
});
