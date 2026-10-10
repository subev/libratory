import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, devices, documents, profiles, shelfDownloads, DEFAULT_PROFILE_ID } from "../schema.ts";
import { env } from "../env.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

const { mockReachable } = vi.hoisted(() => ({
  mockReachable: vi.fn(async (): Promise<{ host: string; origin: string; via: "tailscale" | "lan" } | null> => ({
    host: "192.168.4.12",
    origin: "http://192.168.4.12:3034",
    via: "lan",
  })),
}));
vi.mock("../lib/reachable-address.ts", () => ({
  reachableAddress: mockReachable,
  reachableAddressList: async () => { const a = await mockReachable(); return a ? [a] : []; },
}));
vi.mock("../lib/env-file.ts", () => ({ updateEnvFile: vi.fn() }));

import { phoneRouter } from "./phone.ts";
import { pairingTokens } from "../lib/pairing.ts";
import { hashDeviceKey } from "../lib/shelf.ts";
import { updateEnvFile } from "../lib/env-file.ts";

beforeEach(async () => {
  await resetDb(getDb());
  env.HOST = "0.0.0.0";
  env.NETWORK_ACCESS = "shelf";
});

async function makeProfile(name: string) {
  return row(await getDb().insert(profiles).values({ name }).returning());
}

async function makeDocument(profileId: string, over: Partial<typeof documents.$inferInsert> = {}) {
  const db = getDb();
  const book = row(await db.insert(books).values({ title: "Der Prozess", language: "de", profileId }).returning());
  const doc = row(
    await db
      .insert(documents)
      .values({ bookId: book.id, format: "epub-sync", outputPath: `/nowhere/${book.id}.epub`, chapterCount: 10, chapterSummary: "1-10", chapterIds: "[]", ...over })
      .returning(),
  );
  return { book, doc };
}

async function makeDevice(profileId: string, name: string) {
  return row(await getDb().insert(devices).values({ profileId, name, keyHash: hashDeviceKey(name) }).returning());
}

describe("phone.pairingCode", () => {
  it("mints a code for the caller's profile that the shelf routes accept", async () => {
    const profile = await makeProfile("Petur");
    const out = await phoneRouter.createCaller({ profileId: profile.id }).pairingCode();
    expect(out).toMatchObject({ profileName: "Petur", loopbackOnly: false, access: "shelf", reachable: { via: "lan" } });
    expect(out.code?.image).toMatch(/^data:image\/svg\+xml;base64,/);
    const params = new URLSearchParams(new URL(out.code!.link).hash.slice(1));
    expect(params.get("s")).toBe("http://192.168.4.12:3034");
    expect(pairingTokens.peek(params.get("t")!)).toMatchObject({ profileId: profile.id });
  });

  it("mints nothing while the server listens on loopback, and the fix writes HOST", async () => {
    env.HOST = "127.0.0.1";
    const caller = phoneRouter.createCaller({});
    expect(await caller.pairingCode()).toMatchObject({ loopbackOnly: true, code: null });
    expect(await caller.listenOnNetwork()).toEqual({ restartNeeded: true });
    expect(updateEnvFile).toHaveBeenCalledWith(expect.any(String), "HOST", "0.0.0.0");
  });

  it("mints nothing while the network may reach nothing, and sharing is live", async () => {
    const caller = phoneRouter.createCaller({});
    await caller.setNetworkAccess({ access: "none" });
    expect(updateEnvFile).toHaveBeenCalledWith(expect.any(String), "NETWORK_ACCESS", "none");
    expect(await caller.pairingCode()).toMatchObject({ access: "none", code: null });
    await caller.setNetworkAccess({ access: "shelf" });
    expect((await caller.pairingCode()).code).not.toBeNull();
  });

  it("mints with everything open too, since the shelf is part of everything", async () => {
    env.NETWORK_ACCESS = "all";
    const out = await phoneRouter.createCaller({}).pairingCode();
    expect(out.access).toBe("all");
    expect(out.code?.expiresInMs).toBeGreaterThan(0);
  });

  it("follows PUBLIC_ORIGIN behind a proxy, loopback or not", async () => {
    env.HOST = "127.0.0.1";
    env.PUBLIC_ORIGIN = "https://shelf.example.org";
    try {
      const out = await phoneRouter.createCaller({}).pairingCode();
      expect(out).toMatchObject({ loopbackOnly: false, machine: "shelf.example.org", reachable: { origin: "https://shelf.example.org", host: "shelf.example.org", via: "internet" } });
      const params = new URLSearchParams(new URL(out.code!.link).hash.slice(1));
      expect(params.get("s")).toBe("https://shelf.example.org");
    } finally {
      env.PUBLIC_ORIGIN = undefined;
    }
  });

  it("mints nothing when the machine has no network address", async () => {
    mockReachable.mockResolvedValueOnce(null);
    expect(await phoneRouter.createCaller({}).pairingCode()).toMatchObject({ reachable: null, code: null });
  });
});

describe("phone.setPublic", () => {
  it("marks the caller's profile as the public shelf, live, and clears only its own", async () => {
    const mine = await makeProfile("Commons");
    const caller = phoneRouter.createCaller({ profileId: mine.id });
    try {
      expect((await caller.pairingCode()).isPublic).toBe(false);
      expect(await caller.setPublic({ public: true })).toEqual({ public: true });
      expect(updateEnvFile).toHaveBeenCalledWith(expect.any(String), "PUBLIC_SHELF_PROFILE", mine.id);
      expect((await caller.pairingCode()).isPublic).toBe(true);
      // Another profile turning itself off does not touch the public one
      await phoneRouter.createCaller({}).setPublic({ public: false });
      expect((await caller.pairingCode()).isPublic).toBe(true);
      expect(await caller.setPublic({ public: false })).toEqual({ public: false });
      expect(env.PUBLIC_SHELF_PROFILE).toBeUndefined();
    } finally {
      env.PUBLIC_SHELF_PROFILE = undefined;
    }
  });
});

describe("phone.devices / forget", () => {
  it("lists the profile's phones with how many books each took, and forgets only its own", async () => {
    const mine = await makeProfile("Petur");
    const theirs = await makeProfile("Mira");
    const phone = await makeDevice(mine.id, "iPhone");
    await makeDevice(mine.id, "iPad");
    const other = await makeDevice(theirs.id, "Mira's phone");
    const a = await makeDocument(mine.id);
    const b = await makeDocument(mine.id, { bookId: a.book.id, format: "epub-bilingual", language: "English" });
    await getDb().insert(shelfDownloads).values([
      { deviceId: phone.id, documentId: a.doc.id },
      { deviceId: phone.id, documentId: b.doc.id },
    ]);

    const caller = phoneRouter.createCaller({ profileId: mine.id });
    const list = await caller.devices();
    expect(list.map((d) => [d.name, d.books]).sort()).toEqual([["iPad", 0], ["iPhone", 1]]);

    await expect(caller.forget({ id: other.id })).rejects.toThrow("Phone not found");
    await caller.forget({ id: phone.id });
    expect((await caller.devices()).map((d) => d.name)).toEqual(["iPad"]);
    expect(await getDb().select().from(devices).where(eq(devices.id, other.id))).toHaveLength(1);
  });
});

describe("phone.shelf / setHidden", () => {
  it("shows hidden files to the owner, marks them, and hides only its own", async () => {
    const mine = await makeProfile("Petur");
    const theirs = await makeProfile("Mira");
    const { doc } = await makeDocument(mine.id);
    const foreign = await makeDocument(theirs.id);
    await makeDocument(mine.id, { format: "pdf" });
    const caller = phoneRouter.createCaller({ profileId: mine.id });

    expect((await caller.shelf()).map((d) => [d.id, d.hidden, d.label, d.bytes])).toEqual([[doc.id, false, "German, read-along", null]]);
    await caller.setHidden({ documentId: doc.id, hidden: true });
    expect((await caller.shelf()).map((d) => d.hidden)).toEqual([true]);
    await expect(caller.setHidden({ documentId: foreign.doc.id, hidden: true })).rejects.toThrow("Document not found");
  });

  it("falls back to the default profile without a header", async () => {
    await makeDocument(DEFAULT_PROFILE_ID);
    expect(await phoneRouter.createCaller({}).shelf()).toHaveLength(1);
  });
});
