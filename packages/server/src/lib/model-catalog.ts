import fs from "node:fs";
import path from "node:path";
import { env } from "../env.ts";
import { describeError } from "./errors.ts";

// Metadata the providers will not give us. DeepSeek and OpenAI list bare ids with no context
// window or capability flags, and a context window is what decides whether a book fits in one
// call — see the guards in workers/book-note.ts and workers/digest.ts. models.dev is the
// community catalog maintained against all four providers under their own native model ids.
const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export type CatalogModel = {
  label: string;
  contextTokens?: number;
  supportsTools?: boolean;
  supportsJsonFormat?: boolean;
  supportsTemperature?: boolean;
  // modalities.input names "image"
  vision?: boolean;
};

// provider id -> native model id -> metadata
export type Catalog = Map<string, Map<string, CatalogModel>>;

const EMPTY: Catalog = new Map();

// The payload is 4.5 MB of third-party data covering 213 providers, and we read six fields out of
// it. Hand-walking with typeof guards keeps the parse cheap and tolerates their shape drifting;
// a schema here would reject the whole catalog over one provider we do not use.
function inputModalities(modalities: unknown): string[] | undefined {
  const input = (modalities as Record<string, unknown> | null)?.input;
  return Array.isArray(input) ? input.filter((m): m is string => typeof m === "string") : undefined;
}

export function extract(raw: unknown): Catalog {
  const catalog: Catalog = new Map();
  if (typeof raw !== "object" || raw === null) return catalog;
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    const models = (provider as Record<string, unknown> | null)?.models;
    if (typeof models !== "object" || models === null) continue;
    const byId = new Map<string, CatalogModel>();
    for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
      const model = entry as Record<string, unknown> | null;
      if (typeof model !== "object" || model === null) continue;
      const limit = model.limit as Record<string, unknown> | null;
      const numeric = (of: unknown) => (typeof of === "number" && of > 0 ? of : undefined);
      const flag = (of: unknown) => (typeof of === "boolean" ? of : undefined);
      byId.set(id, {
        label: typeof model.name === "string" ? model.name : id,
        contextTokens: numeric(limit?.context),
        supportsTools: flag(model.tool_call),
        supportsJsonFormat: flag(model.structured_output),
        supportsTemperature: flag(model.temperature),
        vision: inputModalities(model.modalities)?.includes("image"),
      });
    }
    catalog.set(providerId, byId);
  }
  return catalog;
}

let memory: { at: number; catalog: Catalog } | null = null;
let inFlight: Promise<Catalog> | null = null;

function cacheFile(): string {
  return path.join(env.DATA_DIR, "model-catalog.json");
}

export function readDisk(): { at: number; catalog: Catalog } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { fetchedAt?: unknown; data?: unknown };
    if (typeof parsed.fetchedAt !== "number") return null;
    return { at: parsed.fetchedAt, catalog: extract(parsed.data) };
  } catch {
    return null;
  }
}

// The cache holds the provider payload verbatim, not the extracted map, so exactly one extractor
// sits at each end and the two shapes cannot drift. Persisting the extracted form and re-reading
// it through extract() is how every context window was silently lost on the second run: the reader
// looked for `limit.context` on an object already flattened to `{ label, contextTokens }`.
export function writeDisk(raw: unknown): void {
  try {
    fs.mkdirSync(env.DATA_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), data: raw }));
  } catch (err) {
    console.error(`Could not cache the model catalog: ${describeError(err)}`);
  }
}

async function fetchRaw(): Promise<unknown | null> {
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// resolveLlm has to answer synchronously — a running job must not wait on a download to learn how
// big its model's context is. It reads whatever is warm and takes the conservative default when
// nothing is, which is why the server warms this at startup.
export function cachedCatalog(): Catalog {
  return memory?.catalog ?? EMPTY;
}

export function catalogModel(provider: string, modelId: string): CatalogModel | undefined {
  return cachedCatalog().get(provider)?.get(modelId);
}

// Bringing the disk cache into memory before the server takes requests. The background warm-up in
// main.ts is not awaited, which leaves a window where a job resolves against the per-provider
// fallback while the real numbers sit on disk already — and if models.dev is unreachable that
// window never closes, so every context window stays a guess for the life of the process.
export function seedCatalogFromDisk(): void {
  if (memory) return;
  const disk = readDisk();
  if (disk) memory = disk;
}

async function loadCatalog(): Promise<Catalog> {
  const disk = readDisk();
  if (disk && Date.now() - disk.at < CATALOG_TTL_MS) {
    memory = disk;
    return disk.catalog;
  }
  const raw = await fetchRaw();
  if (raw) {
    const catalog = extract(raw);
    memory = { at: Date.now(), catalog };
    writeDisk(raw);
    return catalog;
  }
  // Stale metadata beats none: an expired context window is still the right order of magnitude.
  if (disk) {
    memory = disk;
    return disk.catalog;
  }
  return memory?.catalog ?? EMPTY;
}

export async function modelCatalog(): Promise<Catalog> {
  if (memory && Date.now() - memory.at < CATALOG_TTL_MS) return memory.catalog;
  if (inFlight) return inFlight;
  // Clearing by identity, from out here, rather than from a finally inside the loader: the disk-hit
  // path returns without ever awaiting, so a loader that cleared this itself would run before the
  // assignment below and leave a settled promise in `inFlight` that every later call serves
  // forever — the catalog would never refresh again in that process.
  const pending = loadCatalog();
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}
