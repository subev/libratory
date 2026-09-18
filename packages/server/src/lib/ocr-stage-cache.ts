import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { StageCheckpoint, StageEvidence } from "./ocr-repair.ts";

export type OrderingCheckpoint = StageCheckpoint;
type LegacyEvidence = { model: string; settingsKey: string; lines: unknown; order?: unknown };
const evidenceSchema = z.object({ response: z.string(), output: z.unknown().optional(), message: z.string().nullable(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), repair: z.boolean() });
const legacySchema = z.object({ stage: z.string(), model: z.string(), settingsKey: z.string(), lines: z.unknown(),
  order: z.unknown(), response: z.string().optional(), message: z.string().default("Saved response requires validation") });

async function namesIn(dir: string) {
  try { return await readdir(dir); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function stageCheckpoint(outDir: string, page: number, stage: "ordering" | "transcription", identity: unknown,
  legacy?: LegacyEvidence): StageCheckpoint {
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const dir = path.join(outDir, `${stage}-checkpoints`);
  const file = path.join(dir, `${page}-${key}.json`);
  async function legacyCandidates(wantedStage: string) {
    if (!legacy) return [];
    const candidates: z.infer<typeof legacySchema>[] = [];
    const names = (await namesIn(outDir)).filter((name) => name.startsWith(`ocr-failure-page-${page}-`) && name.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    for (const name of names) {
      const parsed = legacySchema.safeParse(JSON.parse(await readFile(path.join(outDir, name), "utf8")));
      if (parsed.success && parsed.data.stage === wantedStage && parsed.data.model === legacy.model && parsed.data.settingsKey === legacy.settingsKey
        && JSON.stringify(parsed.data.lines) === JSON.stringify(legacy.lines)
        && (legacy.order === undefined || JSON.stringify(parsed.data.order) === JSON.stringify(legacy.order))) candidates.push(parsed.data);
    }
    return candidates;
  }
  async function loadCandidates(): Promise<StageEvidence[]> {
    const candidates: StageEvidence[] = [];
    const names = (await namesIn(dir)).filter((name) => name.startsWith(`${page}-${key}-attempt-`) && name.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    for (const name of names) {
      const evidence = evidenceSchema.parse(JSON.parse(await readFile(path.join(dir, name), "utf8")));
      if (evidence.response) candidates.push(evidence);
    }
    for (const previous of await legacyCandidates(stage)) {
      const output = stage === "ordering" ? previous.order : undefined;
      const response = previous.response ?? (output ? JSON.stringify(output) : "");
      if (response) candidates.push({ output, response, message: previous.message, inputTokens: null, outputTokens: null, repair: false });
    }
    return candidates;
  }
  return {
    async load() {
      try { return JSON.parse(await readFile(file, "utf8")) as unknown; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return stage === "ordering" ? (await legacyCandidates("transcription"))[0]?.order ?? null : null;
    },
    loadCandidates,
    async loadRejected() {
      return (await loadCandidates())[0] ?? null;
    },
    async record(evidence) {
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${page}-${key}-attempt-${Date.now()}-${randomUUID()}.json`);
      const temp = `${target}.part`;
      await writeFile(temp, JSON.stringify(evidence), { mode: 0o600 });
      await rename(temp, target);
    },
    async save(output) {
      await mkdir(dir, { recursive: true });
      const temp = `${file}.${randomUUID()}.part`;
      await writeFile(temp, JSON.stringify(output), { mode: 0o600 });
      await rename(temp, file);
    },
  };
}

export function orderingCheckpoint(outDir: string, page: number, identity: unknown, legacy?: LegacyEvidence): OrderingCheckpoint {
  return stageCheckpoint(outDir, page, "ordering", identity, legacy);
}
