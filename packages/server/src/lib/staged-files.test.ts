import { Readable } from "node:stream";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, resetDb } from "../../test/setup.ts";
import { useTempDataDir } from "../../test/data-dir.ts";
import { DEFAULT_PROFILE_ID, stagedFiles } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { claimStaged, consumeStaged, removeStaged, resolveStaged, stagedDir, stageUpload, sweepStaged, touchStaged, STAGED_TTL_MS } from "./staged-files.ts";
import { createConversation, deleteConversation } from "./chats.ts";
import { assistantTools } from "./assistant-tools.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

const stage = (filename = "dropped.pdf", bytes: Buffer = PDF) => stageUpload({ profileId: DEFAULT_PROFILE_ID, filename, stream: Readable.from([bytes]) });

const exists = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;

describe("staged files", () => {
  // The sweep deletes files it finds no row for; it must run against a directory of this test's own
  const restoreDataDir = useTempDataDir();
  afterAll(restoreDataDir);
  beforeEach(async () => {
    await resetDb(getDb());
    await rm(stagedDir(DEFAULT_PROFILE_ID), { recursive: true, force: true });
  });

  it("stages a dropped PDF under its own name and refuses what is not one", async () => {
    const staged = await stage();
    expect(staged.ref).toMatch(/^staged:[0-9a-f-]{36}$/);
    expect(staged.sizeBytes).toBe(PDF.length);
    const { record, path: onDisk } = await resolveStaged(staged.ref, DEFAULT_PROFILE_ID);
    expect(record.filename).toBe("dropped.pdf");
    expect(record.sha256).toHaveLength(64);
    expect(await exists(onDisk)).toBe(true);

    await expect(stage("notes.txt")).rejects.toThrow(/Not a PDF/);
    await expect(stage("fake.pdf", Buffer.from("hello"))).rejects.toThrow(/Not a PDF/);
    // A refused upload leaves neither a file nor a row
    expect(await getDb().select().from(stagedFiles)).toHaveLength(1);
    expect(await readdir(stagedDir(DEFAULT_PROFILE_ID))).toHaveLength(1);
  });

  it("is reachable through the MCP tools by reference, by its own profile only", async () => {
    const staged = await stage();
    const mine = await assistantTools(DEFAULT_PROFILE_ID);
    try {
      const looked = (await mine.tools.inspect_pdf!.execute!({ path: staged.ref } as never, { toolCallId: "t", messages: [], context: undefined })) as { path: string; pages: number | null };
      expect(looked.path).toBe(staged.ref);
    } finally {
      await mine.close();
    }
    await expect(resolveStaged(staged.ref, crypto.randomUUID())).rejects.toThrow(/No staged file/);
    await expect(resolveStaged("staged:not-an-id", DEFAULT_PROFILE_ID)).rejects.toThrow(/No staged file/);
  });

  it("is consumed by a book, removed by the chip, and says which happened", async () => {
    const used = await stage("used.pdf");
    const removed = await stage("removed.pdf");
    await consumeStaged([used.ref]);
    expect(await removeStaged(removed.id, DEFAULT_PROFILE_ID)).toBe(true);
    await expect(resolveStaged(used.ref, DEFAULT_PROFILE_ID)).rejects.toThrow(/already made into a book/);
    await expect(resolveStaged(removed.ref, DEFAULT_PROFILE_ID)).rejects.toThrow(/removed from the panel/);
    expect(await readdir(stagedDir(DEFAULT_PROFILE_ID))).toHaveLength(0);
  });

  it("belongs to the thread that sends it, and goes when the thread does", async () => {
    const staged = await stage();
    const conversationId = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null);
    // In the order sent, whatever the database returns them in: the person may have arranged them
    const second = await stage("second.pdf");
    const claimed = await claimStaged([second.ref, staged.ref], conversationId, DEFAULT_PROFILE_ID);
    expect(claimed.map((c) => c.filename)).toEqual(["second.pdf", "dropped.pdf"]);
    // A second thread cannot take it
    const other = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null);
    expect(await claimStaged([staged.ref], other, DEFAULT_PROFILE_ID)).toEqual([]);
    const { path: onDisk } = await resolveStaged(staged.ref, DEFAULT_PROFILE_ID);
    await deleteConversation(DEFAULT_PROFILE_ID, conversationId);
    expect(await exists(onDisk)).toBe(false);
    expect(await getDb().select().from(stagedFiles)).toHaveLength(0);
  });

  it("expires a day after its thread was last used, and clears what has no row", async () => {
    const staged = await stage();
    const conversationId = await createConversation(DEFAULT_PROFILE_ID, { kind: "library" }, null);
    await claimStaged([staged.ref], conversationId, DEFAULT_PROFILE_ID);
    const { path: onDisk } = await resolveStaged(staged.ref, DEFAULT_PROFILE_ID);
    const orphan = path.join(stagedDir(DEFAULT_PROFILE_ID), "orphan.pdf");
    await writeFile(orphan, PDF);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await getDb().update(stagedFiles).set({ lastActivityAt: old }).where(eq(stagedFiles.id, staged.id));

    // Still within the day: kept, and the orphan is too young to be judged
    let swept = await sweepStaged(new Date());
    expect(swept.expired).toBe(0);
    expect(await exists(onDisk)).toBe(true);

    // Used again: the clock restarts. The orphan is old enough by now and goes.
    await touchStaged(conversationId);
    swept = await sweepStaged(new Date(Date.now() + STAGED_TTL_MS - 60_000));
    expect(swept).toEqual({ expired: 0, orphans: 1 });

    swept = await sweepStaged(new Date(Date.now() + STAGED_TTL_MS + 60_000));
    expect(swept).toEqual({ expired: 1, orphans: 0 });
    expect(await exists(onDisk)).toBe(false);
    expect(await exists(orphan)).toBe(false);
    await expect(resolveStaged(staged.ref, DEFAULT_PROFILE_ID)).rejects.toThrow(/expired/);
  });
});
