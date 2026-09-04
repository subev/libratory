import { sql } from "drizzle-orm";
import { fromStoredPath, toStoredPath } from "./lib/paths.ts";
import { pgTable, uuid, text, real, integer, timestamp, boolean, jsonb, unique, index, vector, customType, type AnyPgColumn } from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// Stored relative to DATA_DIR, handed out absolute — see toStoredPath. Drizzle never routes null
// through a custom type, so the nullable columns need nothing extra.
const dataPath = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: toStoredPath,
  fromDriver: fromStoredPath,
});

export type ChapterProposalBoundary = {
  fileIndex: number | null;
  blockIndex: number;
  title: string;
  titleTranslated?: string;
  page: number;
};

export type ChapterProposal = {
  status: "running" | "done" | "failed";
  method: "llm" | "deterministic";
  detection?: "llm" | "numbered-headings" | "heading-levels";
  boundaries?: ChapterProposalBoundary[];
  error?: string;
  createdAt: string;
};

export type ChapterCleanup = {
  status: "pending" | "cleaning" | "done" | "failed" | "suspended";
  progress?: string;
  // Which model did the work — a run can land on a different one than Settings asks for
  model?: string;
  error?: string;
  runToken?: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteJob = {
  status: "queued" | "running" | "done" | "failed";
  prompt: string;
  model: string;
  error?: string;
  noteId?: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteScope =
  | { kind: "chapters"; chapters: { id: string; title: string }[] }
  | { kind: "book-raw"; files: number; digestBookId?: string }
  | { kind: "library"; folderId?: string; question: string };

export type SearchIndexJob = {
  // "waiting" is not a failure: the BGE-M3 bundle is an optional 4.2 GB download, and a book that
  // arrives before it does is indexed for keyword search and queued for the rest.
  status: "queued" | "chunking" | "embedding" | "waiting" | "done" | "failed";
  progress?: string;
  error?: string;
  updatedAt: string;
};

export type BookOrigin =
  | { type: "digest"; sourceBookIds: string[]; prompt: string; model: string }
  | { type: "api"; client?: string };

export type DigestJob = {
  status: "running" | "done" | "failed";
  progress?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type VariantParams = {
  temperature?: number;
  // "whole" sends the entire chapter as one chunk (for outputs much shorter than the source)
  mode?: "chunked" | "whole";
  thinking?: boolean;
  model?: string;
};

// Per-lane (variant key) voice/speed overrides; absent fields fall back to books.voice/speed
export type VariantVoices = Record<string, { voice?: string; speed?: number }>;

// Snapshot title so the link label survives source deletion
export type ChapterSource =
  | { kind: "book"; bookId: string; title: string }
  | { kind: "url"; url: string; title?: string }
  | { kind: "note"; noteId: string }
  | { kind: "api"; client?: string };

// Where each source block landed in cleanText; absent when the blocks no longer rebuild rawText
export type ChapterTextMap = {
  version: 1;
  spans: { block: number; start: number; end: number }[];
};

// Pre-profiles data is backfilled onto this fixed id; missing x-profile-id headers resolve to it
export const DEFAULT_PROFILE_ID = "00000000-0000-0000-0000-000000000001";

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().default(DEFAULT_PROFILE_ID).references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("folders_parent_id_idx").on(t.parentId), index("folders_profile_id_idx").on(t.profileId)]);

export const books = pgTable("books", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  // "pdf" books have filename/pdfPath; synthetic kinds (digest, ...) have neither
  kind: text("kind").$type<"pdf" | "digest" | "api">().notNull().default("pdf"),
  filename: text("filename"),
  pdfPath: dataPath("pdf_path"),
  outputPath: dataPath("output_path"),
  status: text("status", {
    enum: ["pending", "extracting", "synthesizing", "assembling", "done", "failed", "suspended"],
  }).notNull().default("pending"),
  voice: text("voice").notNull().default("af_heart"),
  speed: real("speed").notNull().default(1.0),
  variantVoices: jsonb("variant_voices").$type<VariantVoices>(),
  error: text("error"),
  forceOcr: boolean("force_ocr").notNull().default(false),
  llmChapterDetection: boolean("llm_chapter_detection").notNull().default(false),
  // null = default model; registry key from lib/llm.ts
  chapterModel: text("chapter_model"),
  chapterDetection: text("chapter_detection").$type<"llm" | "numbered-headings" | "heading-levels" | "word-split" | "manual">(),
  chapterProposal: jsonb("chapter_proposal").$type<ChapterProposal>(),
  translationLanguage: text("translation_language"),
  language: text("language"),
  // Who wrote it, for a shelf that sorts by more than title — the PDF's own metadata when it has any
  author: text("author"),
  skipSynthesis: boolean("skip_synthesis").notNull().default(false),
  totalChapters: integer("total_chapters").notNull().default(0),
  noteJob: jsonb("note_job").$type<NoteJob>(),
  origin: jsonb("origin").$type<BookOrigin>(),
  digestJob: jsonb("digest_job").$type<DigestJob>(),
  searchIndex: jsonb("search_index").$type<SearchIndexJob>(),
  // "set null", never cascade: book deletion must go through deleteBook (disk cleanup)
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  profileId: uuid("profile_id").notNull().default(DEFAULT_PROFILE_ID).references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("books_folder_id_idx").on(t.folderId), index("books_profile_id_idx").on(t.profileId)]);

export const chapters = pgTable("chapters", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  index: integer("index").notNull(),
  title: text("title").notNull(),
  rawText: text("raw_text").notNull(),
  cleanText: text("clean_text"),
  customText: text("custom_text"),
  audioPath: dataPath("audio_path"),
  durationMs: integer("duration_ms"),
  progress: text("progress"),
  status: text("status", {
    enum: ["pending", "normalizing", "synthesizing", "done", "failed", "suspended"],
  }).notNull().default("pending"),
  selected: boolean("selected").notNull().default(true),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  sourceBlocks: jsonb("source_blocks"),
  textMap: jsonb("text_map").$type<ChapterTextMap>(),
  sourceFileIndex: integer("source_file_index"),
  source: jsonb("source").$type<ChapterSource>(),
  synthesizedWith: jsonb("synthesized_with").$type<{ voice?: string; speed?: number | null }>(),
  cleanup: jsonb("cleanup").$type<ChapterCleanup>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Physical names ("chapter_translations", "language") predate transforms; the
// table now holds any derived rendition of a chapter, keyed by variant key
// (a language name for translations, a preset id or custom slug for transforms).
export const chapterVariants = pgTable("chapter_translations", {
  id: uuid("id").primaryKey().defaultRandom(),
  chapterId: uuid("chapter_id").notNull().references(() => chapters.id, { onDelete: "cascade" }),
  key: text("language").notNull(),
  kind: text("kind", { enum: ["translation", "transform"] }).notNull().default("translation"),
  label: text("label"),
  // Snapshot of the instruction that produced this variant; null for translations
  prompt: text("prompt"),
  params: jsonb("params").$type<VariantParams>(),
  title: text("title"),
  text: text("text").notNull().default(""),
  status: text("status", {
    enum: ["pending", "translating", "done", "failed", "suspended"],
  }).notNull().default("pending"),
  progress: text("progress"),
  error: text("error"),
  sourceHash: text("source_hash"),
  // Fencing token: each translate run writes only while its token is current
  runToken: text("run_token"),
  audioPath: dataPath("audio_path"),
  audioDurationMs: integer("audio_duration_ms"),
  audioStatus: text("audio_status", {
    enum: ["pending", "synthesizing", "done", "failed", "suspended"],
  }),
  audioProgress: text("audio_progress"),
  audioError: text("audio_error"),
  synthesizedWith: jsonb("synthesized_with").$type<{ voice?: string; speed?: number | null }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("chapter_translations_chapter_language").on(t.chapterId, t.key)]);

export const bookLogs = pgTable("book_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  fileIndex: integer("file_index"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookFiles = pgTable("book_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  index: integer("index").notNull(),
  filename: text("filename").notNull(),
  pdfPath: dataPath("pdf_path").notNull(),
  // "raw" = raw text only, marker extraction neither queued nor planned
  status: text("status", {
    enum: ["raw", "pending", "extracting", "done", "failed", "suspended"],
  }).notNull().default("pending"),
  selected: boolean("selected").notNull().default(true),
  skipSynthesis: boolean("skip_synthesis").notNull().default(false),
  rawText: text("raw_text"),
  rawWords: integer("raw_words"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assemblies = pgTable("assemblies", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  language: text("language"),
  outputPath: dataPath("output_path").notNull(),
  durationMs: integer("duration_ms").notNull(),
  chapterCount: integer("chapter_count").notNull(),
  chapterSummary: text("chapter_summary").notNull(),
  chapterIds: text("chapter_ids").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  language: text("language"),
  format: text("format", { enum: ["pdf", "epub", "epub-sync"] }).notNull(),
  outputPath: dataPath("output_path").notNull(),
  chapterCount: integer("chapter_count").notNull(),
  chapterSummary: text("chapter_summary").notNull(),
  chapterIds: text("chapter_ids").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  // null = library-wide answer (scope.kind === "library")
  bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().default(DEFAULT_PROFILE_ID).references(() => profiles.id),
  prompt: text("prompt").notNull(),
  model: text("model").notNull(),
  result: text("result").notNull(),
  scope: jsonb("scope").$type<NoteScope>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookChunks = pgTable("book_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookId: uuid("book_id").notNull().references(() => books.id, { onDelete: "cascade" }),
  // Denormalized from books for index-friendly scoping; refreshed on reindex
  profileId: uuid("profile_id").notNull(),
  folderId: uuid("folder_id"),
  source: text("source", { enum: ["raw", "chapter", "translation"] }).notNull(),
  bookFileId: uuid("book_file_id").references(() => bookFiles.id, { onDelete: "cascade" }),
  chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
  translationId: uuid("translation_id").references(() => chapterVariants.id, { onDelete: "cascade" }),
  language: text("language"),
  seq: integer("seq").notNull(),
  text: text("text").notNull(),
  charStart: integer("char_start").notNull(),
  charEnd: integer("char_end").notNull(),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  // sha256 of the full source-unit text at chunking time; unchanged hash = skip reindex
  sourceHash: text("source_hash").notNull(),
  tsv: tsvector("tsv").generatedAlwaysAs((): ReturnType<typeof sql> => sql`to_tsvector('simple', "text")`),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("book_chunks_book_id_idx").on(t.bookId),
  index("book_chunks_profile_id_idx").on(t.profileId),
  index("book_chunks_file_seq_idx").on(t.bookFileId, t.seq),
  index("book_chunks_chapter_seq_idx").on(t.chapterId, t.seq),
  index("book_chunks_tsv_idx").using("gin", t.tsv),
  index("book_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;
export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
export type BookLog = typeof bookLogs.$inferSelect;
export type BookFile = typeof bookFiles.$inferSelect;
export type NewBookFile = typeof bookFiles.$inferInsert;
export type Assembly = typeof assemblies.$inferSelect;
export type BookDocument = typeof documents.$inferSelect;
export type ChapterVariant = typeof chapterVariants.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type BookChunk = typeof bookChunks.$inferSelect;
export type NewBookChunk = typeof bookChunks.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
