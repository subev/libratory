import path from "node:path";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { stagedFiles } from "../schema.ts";
import { env } from "../env.ts";

// A PDF dropped on the assistant panel is a staged file: uploaded under data/tmp/staged, handed to
// the model as `staged:<id>`, and copied into a book by upload_book — which is the only way it
// leaves. Everything else here is about not keeping it forever.
export const STAGED_PREFIX = "staged:";
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
// Past this, a new drop is refused with a message; nothing is deleted to make room
export const MAX_STAGED_BYTES_PER_PROFILE = 2 * 1024 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

export type StagedFile = typeof stagedFiles.$inferSelect;

export function isStagedRef(value: string): boolean {
  return value.startsWith(STAGED_PREFIX);
}

export function stagedRef(id: string): string {
  return `${STAGED_PREFIX}${id}`;
}

function stagedIdOf(ref: string): string {
  return ref.slice(STAGED_PREFIX.length);
}

// Read from env at call time, not import time, so a test can point it at a directory of its own —
// the sweep deletes files it finds no row for, and must never look at the checkout's ./data
function stagedRoot(): string {
  return path.resolve(env.DATA_DIR, "tmp", "staged");
}

export function stagedDir(profileId: string): string {
  return path.join(stagedRoot(), profileId);
}

async function stagedBytes(profileId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(${stagedFiles.sizeBytes}), 0)::bigint` })
    .from(stagedFiles)
    .where(and(eq(stagedFiles.profileId, profileId), inArray(stagedFiles.status, ["uploading", "ready"])));
  return Number(row?.bytes ?? 0);
}

// One upload at a time per profile: the quota is a read of the rows plus this stream's bytes,
// which is only true while no other upload is adding rows underneath it. Files dropped together
// queue here and still show their progress one after another.
const uploading = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(profileId: string, work: () => Promise<T>): Promise<T> {
  const previous = uploading.get(profileId) ?? Promise.resolve();
  const turn = previous.then(work, work);
  uploading.set(profileId, turn.catch(() => {}));
  try {
    return await turn;
  } finally {
    if (uploading.get(profileId) === turn) uploading.delete(profileId);
  }
}

export class StagedUploadError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
  }
}

// Streams one upload to disk, hashing as it goes, and refuses anything that is not a PDF or would
// take the profile past its share. The row exists from the first byte so a crash mid-upload leaves
// an "uploading" record the sweep can settle, never a nameless file.
export function stageUpload(opts: { profileId: string; filename: string; stream: NodeJS.ReadableStream }): Promise<{ id: string; ref: string; filename: string; sizeBytes: number }> {
  if (!opts.filename.toLowerCase().endsWith(".pdf")) return Promise.reject(new StagedUploadError("Not a PDF", 400));
  return oneAtATime(opts.profileId, () => stageOne(opts));
}

async function stageOne(opts: { profileId: string; filename: string; stream: NodeJS.ReadableStream }): Promise<{ id: string; ref: string; filename: string; sizeBytes: number }> {
  const { profileId, filename } = opts;
  const already = await stagedBytes(profileId);
  if (already >= MAX_STAGED_BYTES_PER_PROFILE) throw new StagedUploadError("The staging area is full — make books from the files already dropped, or remove some", 413);

  const dir = stagedDir(profileId);
  await mkdir(dir, { recursive: true });
  const [row] = await db
    .insert(stagedFiles)
    .values({ profileId, filename, path: path.join(dir, "pending"), status: "uploading" })
    .returning({ id: stagedFiles.id });
  if (!row) throw new Error("Could not record the upload");
  const filePath = path.join(dir, `${row.id}.pdf`);
  await db.update(stagedFiles).set({ path: filePath }).where(eq(stagedFiles.id, row.id));

  const hash = createHash("sha256");
  let size = 0;
  let head = "";
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (head.length < PDF_MAGIC.length) head += chunk.subarray(0, PDF_MAGIC.length - head.length).toString("latin1");
      size += chunk.length;
      hash.update(chunk);
      if (already + size > MAX_STAGED_BYTES_PER_PROFILE) {
        callback(new StagedUploadError("This file would take the staging area past its limit", 413));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(opts.stream, meter, createWriteStream(filePath));
    if (!head.startsWith(PDF_MAGIC)) throw new StagedUploadError("Not a PDF", 400);
    await db
      .update(stagedFiles)
      .set({ sizeBytes: size, sha256: hash.digest("hex"), status: "ready", lastActivityAt: new Date() })
      .where(eq(stagedFiles.id, row.id));
  } catch (err) {
    await unlink(filePath).catch(() => {});
    await db.delete(stagedFiles).where(eq(stagedFiles.id, row.id));
    throw err;
  }
  return { id: row.id, ref: stagedRef(row.id), filename, sizeBytes: size };
}

// The file behind a `staged:` reference, for a tool about to read or copy it. Refused unless it
// belongs to the profile and is still there — a used or expired one names its fate.
export async function resolveStaged(ref: string, profileId: string): Promise<{ record: StagedFile; path: string }> {
  const id = stagedIdOf(ref);
  const [record] = /^[0-9a-f-]{36}$/.test(id) ? await db.select().from(stagedFiles).where(eq(stagedFiles.id, id)) : [];
  if (!record || record.profileId !== profileId) throw new Error(`No staged file ${ref} — it may have been removed; ask for it to be dropped again`);
  switch (record.status) {
    case "ready":
      break;
    case "uploading":
      throw new Error(`${record.filename} is still uploading`);
    case "used":
      throw new Error(`${record.filename} was already made into a book`);
    case "removed":
      throw new Error(`${record.filename} was removed from the panel — ask for it to be dropped again`);
    case "expired":
      throw new Error(`${record.filename} expired — staged files are kept for a day; ask for it to be dropped again`);
    default: {
      const unhandled: never = record.status;
      throw new Error(`unhandled staged status ${unhandled}`);
    }
  }
  const info = await stat(record.path).catch(() => null);
  if (!info?.isFile()) {
    await db.update(stagedFiles).set({ status: "expired", lastActivityAt: new Date() }).where(eq(stagedFiles.id, record.id));
    throw new Error(`${record.filename} is no longer on disk — ask for it to be dropped again`);
  }
  return { record, path: record.path };
}

// After upload_book has copied the files: the staged copies go, the rows say where they went
export async function consumeStaged(refs: string[]): Promise<void> {
  const ids = refs.filter(isStagedRef).map(stagedIdOf);
  if (ids.length === 0) return;
  const rows = await db.select({ id: stagedFiles.id, path: stagedFiles.path }).from(stagedFiles).where(inArray(stagedFiles.id, ids));
  await Promise.all(rows.map((r) => unlink(r.path).catch(() => {})));
  await db.update(stagedFiles).set({ status: "used", lastActivityAt: new Date() }).where(inArray(stagedFiles.id, ids));
}

// The × on a chip
export async function removeStaged(id: string, profileId: string): Promise<boolean> {
  const [row] = await db.select({ path: stagedFiles.path }).from(stagedFiles).where(and(eq(stagedFiles.id, id), eq(stagedFiles.profileId, profileId)));
  if (!row) return false;
  await unlink(row.path).catch(() => {});
  await db.update(stagedFiles).set({ status: "removed", lastActivityAt: new Date() }).where(eq(stagedFiles.id, id));
  return true;
}

// The thread that sends a file owns it from then on: its deletion takes the file, its activity
// keeps the file alive
export async function claimStaged(refs: string[], conversationId: string, profileId: string): Promise<StagedFile[]> {
  const ids = refs.filter(isStagedRef).map(stagedIdOf);
  if (ids.length === 0) return [];
  const rows = await db
    .update(stagedFiles)
    .set({ conversationId, lastActivityAt: new Date() })
    .where(and(inArray(stagedFiles.id, ids), eq(stagedFiles.profileId, profileId), isNull(stagedFiles.conversationId)))
    .returning();
  // In the order they were sent: the person may have arranged them, and RETURNING has no order
  return rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

// Deleting a thread takes its files: the rows cascade, the bytes do not
export async function removeStagedForConversation(conversationId: string): Promise<void> {
  const rows = await db.select({ path: stagedFiles.path }).from(stagedFiles).where(and(eq(stagedFiles.conversationId, conversationId), inArray(stagedFiles.status, ["uploading", "ready"])));
  await Promise.all(rows.map((r) => unlink(r.path).catch(() => {})));
}

export async function touchStaged(conversationId: string): Promise<void> {
  await db.update(stagedFiles).set({ lastActivityAt: new Date() }).where(and(eq(stagedFiles.conversationId, conversationId), eq(stagedFiles.status, "ready")));
}

// What a thread holds, for the model's context: the files it can still use, and the ones already
// made into a book — named so a reference that worked earlier is known to be spent, not guessed at
export async function listStaged(conversationId: string): Promise<{ ref: string; filename: string; sizeBytes: number; status: "ready" | "used" }[]> {
  const rows = await db
    .select({ id: stagedFiles.id, filename: stagedFiles.filename, sizeBytes: stagedFiles.sizeBytes, status: stagedFiles.status })
    .from(stagedFiles)
    .where(and(eq(stagedFiles.conversationId, conversationId), inArray(stagedFiles.status, ["ready", "used"])))
    .orderBy(stagedFiles.createdAt);
  return rows.flatMap((r) => (r.status === "ready" || r.status === "used" ? [{ ref: stagedRef(r.id), filename: r.filename, sizeBytes: r.sizeBytes, status: r.status }] : []));
}

// Runs at start and then hourly. Files a day past their thread's last activity expire; a file with
// no live row is removed, a live row with no file is expired; rows of files long gone are dropped.
export async function sweepStaged(now = new Date()): Promise<{ expired: number; orphans: number }> {
  const cutoff = new Date(now.getTime() - STAGED_TTL_MS);
  const stale = await db
    .select({ id: stagedFiles.id, path: stagedFiles.path })
    .from(stagedFiles)
    .where(and(inArray(stagedFiles.status, ["uploading", "ready"]), lt(stagedFiles.lastActivityAt, cutoff)));
  await Promise.all(stale.map((r) => unlink(r.path).catch(() => {})));
  // The row is kept a day past its expiry, stamped now, so a chip can still say why the file is gone
  if (stale.length > 0) await db.update(stagedFiles).set({ status: "expired", lastActivityAt: now }).where(inArray(stagedFiles.id, stale.map((r) => r.id)));

  const live = await db
    .select({ id: stagedFiles.id, path: stagedFiles.path })
    .from(stagedFiles)
    .where(inArray(stagedFiles.status, ["uploading", "ready"]));
  const livePaths = new Set(live.map((r) => path.resolve(r.path)));
  let orphans = 0;
  const root = stagedRoot();
  for (const profile of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, profile);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      if (livePaths.has(path.resolve(file))) continue;
      const info = await stat(file).catch(() => null);
      // An upload in progress has a row but the file is still growing; only settled files count
      if (info?.isFile() && info.mtimeMs < now.getTime() - 60_000) {
        await unlink(file).catch(() => {});
        orphans += 1;
      }
    }
  }
  const gone = (await Promise.all(live.map(async (r) => ((await stat(r.path).catch(() => null))?.isFile() ? null : r.id)))).filter((id): id is string => id !== null);
  if (gone.length > 0) await db.update(stagedFiles).set({ status: "expired", lastActivityAt: now }).where(inArray(stagedFiles.id, gone));

  await db.delete(stagedFiles).where(and(inArray(stagedFiles.status, ["used", "removed", "expired"]), lt(stagedFiles.lastActivityAt, cutoff)));
  return { expired: stale.length + gone.length, orphans };
}
