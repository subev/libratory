import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { db } from "../db.ts";
import { books, chapters, documents, type Book } from "../schema.ts";
import { EpubImportError } from "./epub-import.ts";
import { appendLog } from "./log.ts";
import { bookOutputDir } from "./paths.ts";
import { ownFolderId } from "./pdf-books.ts";
import { queueIndexBook } from "./search-index.ts";
import { syncMapPath, type SyncMap } from "./sync-map.ts";
import { laneFromRecordings, type Recording } from "./document-narration.ts";
import type { ReaderCues, ReaderManifest } from "./reader-format.ts";
import { chapterTextFromCues, documentFormatOf, isReaderCues, isReaderManifest, layerEntryPath, syncMapFromCues } from "./synced-epub.ts";

const execFileAsync = promisify(execFile);
const TEXT_BUFFER = 64 * 1024 * 1024;
// Audio is stored, not deflated, so what an export declares is about what it holds; an archive
// claiming many times its own size is a bomb, not a book
const DECLARED_TO_ACTUAL = 4;

// A read-along export brought back as a finished book: the file the phone downloads is also the
// one the workshop can take in. Read with the system unzip, entry by entry, because a book is a
// couple of gigabytes of audio and none of it belongs in memory — each recording streams from
// the archive to its own file under the book's output directory, and the EPUB itself becomes
// the shelf document.

export type CreateSyncedEpubBookInput = {
  epubPath: string;
  filename: string;
  title?: string | null;
  folderId?: string | null;
};

type Entry = { name: string; size: number };

// `unzip -l` is the one listing that gives sizes with names; the header, rule and total lines
// have fewer columns than an entry and fall through the pattern
async function listEntries(epub: string): Promise<Map<string, Entry>> {
  const { stdout } = await execFileAsync("unzip", ["-l", epub], { maxBuffer: TEXT_BUFFER });
  const entries = new Map<string, Entry>();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) entries.set(m[2], { name: m[2], size: Number(m[1]) });
  }
  return entries;
}

// unzip reads a member name as a pattern; the few characters that would make it one are escaped
function member(entry: string): string {
  return entry.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
}

async function readEntry(epub: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync("unzip", ["-p", epub, member(entry)], { maxBuffer: TEXT_BUFFER });
  return stdout;
}

function readJson<T>(text: string, guard: (v: unknown) => v is T, what: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EpubImportError(`The read-along EPUB's ${what} is not readable`);
  }
  if (!guard(parsed)) throw new EpubImportError(`The read-along EPUB's ${what} has an unexpected shape`);
  return parsed;
}

// One entry, streamed from the archive to its own file: no shared staging directory for
// basenames to collide in, no argument list to overflow, nothing held in memory
async function extractEntry(epub: string, entry: string, target: string): Promise<void> {
  const child = spawn("unzip", ["-p", epub, member(entry)], { stdio: ["ignore", "pipe", "ignore"] });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  await pipeline(child.stdout, createWriteStream(target));
  if ((await exit) !== 0) throw new EpubImportError(`The read-along EPUB's recording "${path.posix.basename(entry)}" could not be read`);
}

// A rename across mounts fails with EXDEV; copying is the same move, slower
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EXDEV")) throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

// The manifest a Libratory export carries, or null for any other EPUB (or anything that is not a zip)
export async function syncedEpubManifest(epub: string): Promise<{ entry: string; entries: Map<string, Entry>; manifest: ReaderManifest } | null> {
  let entries: Map<string, Entry>;
  try {
    entries = await listEntries(epub);
  } catch {
    return null;
  }
  const entry = [...entries.keys()].find((e) => e === "p2af/book.json" || e.endsWith("/p2af/book.json"));
  if (!entry) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readEntry(epub, entry));
  } catch {
    return null;
  }
  return isReaderManifest(parsed) ? { entry, entries, manifest: parsed } : null;
}

function chapterFile(index: number, ext: string): string {
  return `ch${String(index).padStart(3, "0")}${ext}`;
}

function safeName(filename: string): string {
  return path.basename(filename).replace(/[^\w.\- ]+/g, "_").slice(0, 150) || "book.epub";
}

type ImportedChapter = {
  index: number;
  title: string;
  text: string;
  audioEntry: string | null;
  audioPath: string | null;
  sync: SyncMap | null;
  durationMs: number | null;
};

export async function createSyncedEpubBook(bookId: string, input: CreateSyncedEpubBookInput, profileId: string): Promise<Book> {
  const found = await syncedEpubManifest(input.epubPath);
  if (!found) throw new EpubImportError("Not a Libratory read-along EPUB");
  const { manifest, entry: bookJson, entries } = found;

  const outDir = bookOutputDir(bookId);
  await mkdir(outDir, { recursive: true });

  const imported: ImportedChapter[] = [];
  for (const [index, entry] of manifest.chapters.entries()) {
    const cuesEntry = entry.cues ? layerEntryPath(bookJson, entry.cues) : null;
    const audioEntry = entry.audio ? layerEntryPath(bookJson, entry.audio) : null;
    const narrated = cuesEntry !== null && audioEntry !== null && entries.has(cuesEntry) && entries.has(audioEntry);
    const doc = narrated ? readJson<ReaderCues>(await readEntry(input.epubPath, cuesEntry), isReaderCues, `cues for "${entry.title}"`) : null;
    const textEntry = entry.text ? layerEntryPath(bookJson, entry.text) : null;
    const carried = textEntry && entries.has(textEntry)
      ? readJson(await readEntry(input.epubPath, textEntry), (v): v is { text?: string } => typeof v === "object" && v !== null, `text for "${entry.title}"`).text ?? ""
      : "";
    imported.push({
      index,
      title: entry.title,
      text: doc ? chapterTextFromCues(doc) : carried,
      audioEntry: doc ? audioEntry : null,
      audioPath: doc && audioEntry ? path.join(outDir, chapterFile(index, path.posix.extname(audioEntry))) : null,
      sync: doc ? syncMapFromCues(doc) : null,
      durationMs: doc?.totalMs ?? entry.durationMs,
    });
  }
  if (imported.every((ch) => !ch.text && !ch.audioPath)) throw new EpubImportError("The read-along EPUB carries no chapters to restore");

  // The audio: each recording straight from the archive to its own file, once the sizes the
  // archive declares are seen to be honest
  const withAudio = imported.filter((ch): ch is ImportedChapter & { audioEntry: string; audioPath: string; sync: SyncMap } => ch.audioEntry !== null && ch.audioPath !== null && ch.sync !== null);
  const declared = withAudio.reduce((sum, ch) => sum + (entries.get(ch.audioEntry)?.size ?? 0), 0);
  const actual = (await stat(input.epubPath)).size;
  if (declared > actual * DECLARED_TO_ACTUAL) throw new EpubImportError("The read-along EPUB claims far more audio than the file holds");
  for (const ch of withAudio) {
    await extractEntry(input.epubPath, ch.audioEntry, ch.audioPath);
    await writeFile(syncMapPath(ch.audioPath), JSON.stringify(ch.sync));
  }

  // The file itself is the shelf document, so it lives with the book's other outputs
  const documentPath = path.join(outDir, safeName(input.filename));
  await move(input.epubPath, documentPath);

  const folderId = await ownFolderId(input.folderId, profileId);
  const title = input.title?.trim() || manifest.book.title || input.filename.replace(/\.epub$/i, "");
  const [book] = await db
    .insert(books)
    .values({
      id: bookId,
      title: title.slice(0, 500),
      kind: "ebook",
      author: manifest.book.author,
      language: manifest.book.language || null,
      origin: { type: "synced-epub", filename: input.filename },
      voice: "kokoro:af_heart",
      skipSynthesis: true,
      folderId,
      profileId,
    })
    .returning();
  if (!book) throw new Error("Failed to create book");

  const rows = await db
    .insert(chapters)
    .values(
      imported.map((ch) => ({
        bookId,
        index: ch.index,
        title: ch.title,
        rawText: ch.text,
        cleanText: ch.text,
        status: ch.audioPath ? ("done" as const) : ("suspended" as const),
        audioPath: ch.audioPath,
        durationMs: ch.durationMs,
      })),
    )
    .returning({ id: chapters.id });

  const { format, language } = documentFormatOf(manifest);
  const recordings: Recording[] = withAudio.map((ch) => ({ audioPath: ch.audioPath, durationMs: ch.durationMs, voice: null }));
  await db.insert(documents).values({
    bookId,
    language,
    format,
    outputPath: documentPath,
    chapterCount: imported.length,
    chapterSummary: imported.length === 1 ? "1" : `1-${imported.length}`,
    chapterIds: JSON.stringify(rows.map((r) => r.id)),
    narration: { original: await laneFromRecordings(recordings), translation: null },
  });

  await appendLog(bookId, `Imported read-along EPUB "${input.filename}": ${imported.length} chapter${imported.length === 1 ? "" : "s"}, ${withAudio.length} with narration, on the shelf as ${format}`);
  await queueIndexBook(bookId);
  return book;
}
