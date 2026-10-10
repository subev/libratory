import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db.ts";
import { chapters, chapterVariants, documents, type DocumentNarration, type NarrationLane, type SynthesizedWith } from "../schema.ts";
import { cuesFromSyncMap } from "./cues.ts";
import type { CueGranularity } from "./reader-format.ts";
import { readSyncMap } from "./sync-map.ts";
import { POCKET_VOICES } from "./pocket.ts";
import { kokoroVoiceGroups, narratorVoices, normalizeVoiceId } from "./voice-catalog.ts";

// What a shelf row says about a file's narration — the level the reader can light, the running
// time, the voices — computed once when the export is written and kept on the documents row,
// because a listing of forty files must not open forty sync maps.

export type Recording = { audioPath: string; durationMs: number | null; voice: string | null | undefined };

function titleCase(slug: string): string {
  return slug.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// The name a person knows the voice by. The static catalogs answer by id; runtime engines
// (system voices, Pocket, the cloud libraries) are named from the id itself, since their lists
// are a process or an API away and a label is not worth that on every export.
export function voiceLabel(voiceId: string | null | undefined): string | null {
  if (!voiceId) return null;
  const id = normalizeVoiceId(voiceId);
  for (const group of kokoroVoiceGroups) {
    const found = group.voices.find((v) => v.id === id);
    if (found) return found.label;
  }
  const narrator = narratorVoices.find((v) => v.id === id);
  if (narrator) return narrator.label;
  const [engine, ...rest] = id.split(":");
  const tail = rest[rest.length - 1] ?? "";
  switch (engine) {
    case "pocket":
      if (rest[0] === "custom") return "Cloned voice";
      return POCKET_VOICES.find((v) => v.id === tail)?.name ?? titleCase(tail);
    case "cartesia":
      return "Cartesia voice";
    case "say":
    case "elevenlabs":
      return titleCase(tail);
    default:
      return tail ? titleCase(tail) : id;
  }
}

const LEVEL_RANK: Record<CueGranularity, number> = { chunk: 0, sentence: 1, word: 2 };

// Over a whole file: every chapter at word level is word level; none is chunk; a mix is sentence,
// the same rule cuesFromSyncMap applies within one chapter
export function combineLevels(levels: CueGranularity[]): CueGranularity {
  if (levels.length === 0) return "chunk";
  if (levels.every((l) => l === "word")) return "word";
  if (levels.every((l) => l === "chunk")) return "chunk";
  return "sentence";
}

export function finestLevel(levels: CueGranularity[]): CueGranularity | null {
  return levels.reduce<CueGranularity | null>((best, l) => (best === null || LEVEL_RANK[l] > LEVEL_RANK[best] ? l : best), null);
}

export async function laneFromRecordings(recordings: Recording[]): Promise<NarrationLane | null> {
  if (recordings.length === 0) return null;
  const levels: CueGranularity[] = [];
  const voices = new Set<string>();
  let durationMs = 0;
  for (const r of recordings) {
    const map = await readSyncMap(r.audioPath);
    levels.push(map ? cuesFromSyncMap(map).granularity : "chunk");
    durationMs += r.durationMs ?? map?.totalMs ?? 0;
    const label = voiceLabel(r.voice);
    if (label) voices.add(label);
  }
  return { level: combineLevels(levels), durationMs, voice: voices.size > 0 ? [...voices].join(", ") : null };
}

function withAudio(rows: { audioPath: string | null; durationMs: number | null; synthesizedWith: SynthesizedWith | null }[]): Recording[] {
  return rows.flatMap((r) => (r.audioPath ? [{ audioPath: r.audioPath, durationMs: r.durationMs, voice: r.synthesizedWith?.voice }] : []));
}

// The original text's finished recordings among these chapters, in chapter order
async function originalLane(chapterIds: string[]): Promise<NarrationLane | null> {
  if (chapterIds.length === 0) return null;
  const rows = await db
    .select({ audioPath: chapters.audioPath, durationMs: chapters.durationMs, synthesizedWith: chapters.synthesizedWith, index: chapters.index })
    .from(chapters)
    .where(and(inArray(chapters.id, chapterIds), eq(chapters.status, "done")))
    .orderBy(chapters.index);
  return laneFromRecordings(withAudio(rows));
}

// The translation's finished recordings for the same chapters
async function translationLane(chapterIds: string[], key: string): Promise<NarrationLane | null> {
  if (chapterIds.length === 0) return null;
  const rows = await db
    .select({ audioPath: chapterVariants.audioPath, durationMs: chapterVariants.audioDurationMs, synthesizedWith: chapterVariants.synthesizedWith, index: chapters.index })
    .from(chapterVariants)
    .innerJoin(chapters, eq(chapterVariants.chapterId, chapters.id))
    .where(and(inArray(chapterVariants.chapterId, chapterIds), eq(chapterVariants.key, key), eq(chapterVariants.audioStatus, "done")))
    .orderBy(chapters.index);
  return laneFromRecordings(withAudio(rows));
}

export async function bilingualNarration(
  chapterIds: string[],
  key: string,
  options: { sourceAudio: boolean; targetAudio: boolean },
): Promise<DocumentNarration> {
  return {
    original: options.sourceAudio ? await originalLane(chapterIds) : null,
    translation: options.targetAudio ? await translationLane(chapterIds, key) : null,
  };
}

// What the shelf listing hands a reader, flattened: narrated at all, total running time, the
// voices across both lanes, the finest level, and the level per lane for a bilingual file
export type NarrationSummary = {
  narrated: boolean;
  durationMs: number | null;
  voice: string | null;
  level: CueGranularity | null;
  levels: { source: CueGranularity | null; target: CueGranularity | null };
};

export function narrationSummary(narration: DocumentNarration | null): NarrationSummary {
  const lanes = [narration?.original, narration?.translation].filter((lane): lane is NarrationLane => lane !== null && lane !== undefined);
  const voices = new Set(lanes.flatMap((lane) => (lane.voice ? [lane.voice] : [])));
  return {
    narrated: lanes.length > 0,
    durationMs: lanes.length > 0 ? lanes.reduce((sum, lane) => sum + lane.durationMs, 0) : null,
    voice: voices.size > 0 ? [...voices].join(", ") : null,
    level: finestLevel(lanes.map((lane) => lane.level)),
    levels: { source: narration?.original?.level ?? null, target: narration?.translation?.level ?? null },
  };
}

// A bilingual export's filename records which recordings it carried: `_audio-original_`,
// `_audio-original-<lang>_`, `_audio-<lang>_` or `_audio-none_` — the one place older rows say so
export function bilingualLanesFromFilename(outputPath: string): { sourceAudio: boolean; targetAudio: boolean } {
  // A language slug starts with a letter and the timestamp after it with a digit
  const m = /_audio-([a-z][a-z0-9-]*?)(?:_pages)?_\d/i.exec(outputPath);
  const voices = m?.[1] ?? "none";
  if (voices === "none") return { sourceAudio: false, targetAudio: false };
  if (voices === "original") return { sourceAudio: true, targetAudio: false };
  return { sourceAudio: voices.startsWith("original-"), targetAudio: true };
}

export function parseChapterIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Rows written before the column existed: read their sync maps once, at startup
export async function backfillDocumentNarration(): Promise<number> {
  const rows = await db
    .select({ id: documents.id, format: documents.format, language: documents.language, chapterIds: documents.chapterIds, outputPath: documents.outputPath })
    .from(documents)
    .where(and(isNull(documents.narration), inArray(documents.format, ["epub-sync", "epub-bilingual"])));
  for (const row of rows) {
    const ids = parseChapterIds(row.chapterIds);
    let narration: DocumentNarration;
    if (row.format === "epub-bilingual") {
      narration = await bilingualNarration(ids, row.language ?? "", bilingualLanesFromFilename(row.outputPath));
    } else if (row.language) {
      narration = { original: null, translation: await translationLane(ids, row.language) };
    } else {
      narration = { original: await originalLane(ids), translation: null };
    }
    await db.update(documents).set({ narration }).where(eq(documents.id, row.id));
  }
  return rows.length;
}
