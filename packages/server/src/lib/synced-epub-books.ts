import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { books, chapters, documents, type Book, type DocumentNarration, type NarrationLane } from "../schema.ts";
import { EpubImportError } from "./epub-import.ts";
import { appendLog } from "./log.ts";
import { bookOutputDir } from "./paths.ts";
import { ownFolderId } from "./pdf-books.ts";
import { queueIndexBook } from "./search-index.ts";
import { syncMapPath, type SyncMap } from "./sync-map.ts";
import { combineLevels, laneFromRecordings, type Recording } from "./document-narration.ts";
import type { CueGranularity } from "./reader-format.ts";
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
  return entriesFromListing(stdout);
}

// A name listed twice is refused: `unzip -p` streams every member of that name, so the size the
// listing declares for it is not the size extracting it writes
export function entriesFromListing(listing: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (entries.has(m[2])) throw new EpubImportError(`The read-along EPUB lists "${path.posix.basename(m[2])}" twice`);
    entries.set(m[2], { name: m[2], size: Number(m[1]) });
  }
  return entries;
}

// A recording lands under the output directory, which /files/* serves as it is: only the two
// encodings an export writes may name the file, never whatever extension the archive carried
function audioExtension(entry: string): string {
  const ext = path.posix.extname(entry).toLowerCase();
  if (ext !== ".m4a" && ext !== ".mp3") throw new EpubImportError(`The read-along EPUB's recording "${path.posix.basename(entry)}" is not an M4A or MP3 file`);
  return ext;
}

function chapterSummary(count: number): string {
  return count === 1 ? "1" : `1-${count}`;
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

// A second export under the same name must not land on the first's bytes
async function freePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? filename : `${base} (${n})${ext}`);
    if (!(await stat(candidate).then(() => true, () => false))) return candidate;
  }
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

const LEVELS = new Set<string>(["word", "sentence", "chunk"]);

function levelOf(granularity: unknown): CueGranularity {
  return typeof granularity === "string" && LEVELS.has(granularity) ? (granularity as CueGranularity) : "chunk";
}

type LaneNarration = { totalMs?: unknown; anchors?: unknown; voice?: unknown } | null | undefined;
function laneLevel(narration: LaneNarration): CueGranularity {
  const anchors = Array.isArray(narration?.anchors) ? narration.anchors : [];
  return anchors.some((a: unknown) => typeof a === "object" && a !== null && (a as { kind?: unknown }).kind === "word") ? "word" : "sentence";
}

// What the file says about its own narration: the cue documents' granularity for the original
// lane, and the bilingual documents' anchors for the translation's — so an edition kept whole
// is described as the reader will find it, not guessed
async function narrationFromLayer(epub: string, bookJson: string, entries: Map<string, Entry>, manifest: ReaderManifest): Promise<DocumentNarration> {
  type Side = { levels: CueGranularity[]; ms: number; voices: Set<string> };
  const original: Side = { levels: [], ms: 0, voices: new Set() };
  const translation: Side = { levels: [], ms: 0, voices: new Set() };
  const add = (side: Side, level: CueGranularity, ms: unknown, voice: unknown) => {
    side.levels.push(level);
    side.ms += typeof ms === "number" ? ms : 0;
    if (typeof voice === "string" && voice.trim()) side.voices.add(voice.trim());
  };
  // The document is listed under its first translation; a second one's recording is not its lane
  const { language: key } = documentFormatOf(manifest);
  for (const ch of manifest.chapters) {
    const cuesEntry = ch.cues ? layerEntryPath(bookJson, ch.cues) : null;
    const hasCues = cuesEntry !== null && entries.has(cuesEntry);
    if (hasCues) {
      const doc = readJson<ReaderCues>(await readEntry(epub, cuesEntry), isReaderCues, `cues for "${ch.title}"`);
      add(original, levelOf(doc.granularity), doc.totalMs, (ch as { voice?: unknown }).voice);
    }
    for (const pair of (ch.bilingual ?? []).filter((p) => p.key === key)) {
      const entry = layerEntryPath(bookJson, pair.url);
      if (!entries.has(entry)) continue;
      const doc = readJson(await readEntry(epub, entry), (v): v is { source?: { narration?: LaneNarration }; target?: { narration?: LaneNarration } } => typeof v === "object" && v !== null, `pairing for "${ch.title}"`);
      if (!hasCues && doc.source?.narration) add(original, laneLevel(doc.source.narration), doc.source.narration.totalMs, doc.source.narration.voice);
      if (doc.target?.narration) add(translation, laneLevel(doc.target.narration), doc.target.narration.totalMs, doc.target.narration.voice);
    }
  }
  const lane = (side: Side): NarrationLane | null =>
    side.levels.length === 0 ? null : { level: combineLevels(side.levels), durationMs: side.ms, voice: side.voices.size ? [...side.voices].join(", ") : null };
  return { original: lane(original), translation: lane(translation) };
}

// The restored recordings say what the lane is; the voices are the layer's, since a restored chapter
// knows no voice id and the label is all the exporting machine wrote down
function originalLane(restored: NarrationLane | null, layer: NarrationLane | null): NarrationLane | null {
  if (!restored) return layer;
  return { ...restored, voice: restored.voice ?? layer?.voice ?? null };
}

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
      audioPath: doc && audioEntry ? path.join(outDir, chapterFile(index, audioExtension(audioEntry))) : null,
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
  const layerNarration = await narrationFromLayer(input.epubPath, bookJson, entries, manifest);
  const documentPath = await freePath(outDir, safeName(input.filename));
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
      description: typeof manifest.book.description === "string" ? Array.from(manifest.book.description).slice(0, 2000).join("") : null,
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
    chapterSummary: chapterSummary(imported.length),
    chapterIds: JSON.stringify(rows.map((r) => r.id)),
    narration: { original: originalLane(await laneFromRecordings(recordings), layerNarration.original), translation: layerNarration.translation },
  });

  await appendLog(bookId, `Imported read-along EPUB "${input.filename}": ${imported.length} chapter${imported.length === 1 ? "" : "s"}, ${withAudio.length} with narration, on the shelf as ${format}`);
  await queueIndexBook(bookId);
  return book;
}

// A second edition of a book already on the shelf — the bilingual copy beside the read-along — is
// the file as a document on that book, nothing restored into chapters: the phone groups editions
// by book, and a second import would have made a second book
export async function attachSyncedEpubDocument(bookId: string, input: CreateSyncedEpubBookInput, profileId: string): Promise<{ documentId: string }> {
  const [book] = await db.select({ id: books.id, profileId: books.profileId }).from(books).where(eq(books.id, bookId));
  if (!book || book.profileId !== profileId) throw new EpubImportError("No such book to attach the file to");
  const found = await syncedEpubManifest(input.epubPath);
  if (!found) throw new EpubImportError("Not a Libratory read-along EPUB");
  const { manifest, entry: bookJson, entries } = found;
  const outDir = bookOutputDir(bookId);
  await mkdir(outDir, { recursive: true });
  const documentPath = await freePath(outDir, safeName(input.filename));
  const { format, language } = documentFormatOf(manifest);
  const narration = await narrationFromLayer(input.epubPath, bookJson, entries, manifest);
  // The row first: a move that fails then leaves a row to delete rather than a file nobody knows
  const [doc] = await db
    .insert(documents)
    .values({
      bookId,
      language,
      format,
      outputPath: documentPath,
      chapterCount: manifest.chapters.length,
      chapterSummary: chapterSummary(manifest.chapters.length),
      chapterIds: "[]",
      narration,
    })
    .returning({ id: documents.id });
  if (!doc) throw new Error("Failed to record the document");
  try {
    await move(input.epubPath, documentPath);
  } catch (err) {
    await db.delete(documents).where(eq(documents.id, doc.id));
    throw err;
  }
  await appendLog(bookId, `Attached read-along EPUB "${input.filename}" as a ${format} edition`);
  return { documentId: doc.id };
}
