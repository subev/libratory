import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const savedSchema = z.object({ pages: z.array(z.unknown().nullable()), complete: z.boolean().optional() });
const diagnosticSchema = z.object({
  page: z.number().int().positive(), stage: z.string(), message: z.string(),
  response: z.string().optional(), order: z.unknown().optional(),
  lines: z.array(z.object({ id: z.number(), text: z.string() })).optional(),
});
export type ExtractionProgress = {
  saved: number; total: number | null; reviewPages: number[]; interruptedPages: number[];
  complete: boolean; problem: string | null;
};
const cache = new Map<string, { key: string; value: ExtractionProgress }>();

async function optionalStat(file: string) {
  try { return await stat(file); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function extractionDiagnostics(outDir: string) {
  if (!await optionalStat(outDir)) return [];
  const names = (await readdir(outDir)).filter((name) => /^ocr-failure-page-\d+-\d+\.json$/.test(name)).sort();
  const latest = new Map<number, z.infer<typeof diagnosticSchema>>();
  for (const name of names) {
    const parsed = diagnosticSchema.safeParse(JSON.parse(await readFile(path.join(outDir, name), "utf8")));
    if (parsed.success) latest.set(parsed.data.page, parsed.data);
  }
  return [...latest.values()].sort((a, b) => a.page - b.page);
}

export async function extractionProgress(outDir: string): Promise<ExtractionProgress | null> {
  try {
    const file = path.join(outDir, "llm-pages.json");
    const [savedStat, dirStat] = await Promise.all([optionalStat(file), optionalStat(outDir)]);
    if (!dirStat) return null;
    const key = `${savedStat?.mtimeMs}:${savedStat?.size}:${dirStat.mtimeMs}`;
    const cached = cache.get(outDir);
    if (cached?.key === key) return cached.value;
    const saved = savedStat ? savedSchema.parse(JSON.parse(await readFile(file, "utf8"))) : null;
    const diagnostics = await extractionDiagnostics(outDir);
    if (!saved && !diagnostics.length) return null;
    const unresolved = diagnostics.filter((entry) => !saved?.pages[entry.page - 1]);
    const value: ExtractionProgress = {
      saved: saved?.pages.filter((page) => page !== null).length ?? 0, total: saved?.pages.length ?? null,
      complete: saved !== null && saved.complete !== false && saved.pages.every((page) => page !== null), problem: null,
      reviewPages: unresolved.filter((entry) => entry.response).map((entry) => entry.page),
      interruptedPages: unresolved.filter((entry) => !entry.response).map((entry) => entry.page),
    };
    if (cache.size >= 128) cache.clear();
    cache.set(outDir, { key, value });
    return value;
  } catch {
    return { saved: 0, total: null, complete: false, reviewPages: [], interruptedPages: [],
      problem: "Saved extraction could not be inspected. Nothing has been removed; check the checkpoint before retrying." };
  }
}
