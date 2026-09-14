import fs from "node:fs";
import path from "node:path";
import { env } from "../env.ts";
import { LLM_SECRETS, isConfigured, type LlmSecretProvider, type SecretVar } from "./secrets.ts";
import { catalogModel, modelCatalog, type CatalogModel } from "./model-catalog.ts";
import { describeError } from "./errors.ts";
import type { LlmModelDef } from "./llm.ts";

// Every key a cloud model's metadata can come from, most specific first. The provider's own
// listing wins where it reports anything — Anthropic and Google do, DeepSeek and OpenAI do not —
// then the shared catalog, then the conventions below.
//
// The conventions are per provider, not per model, which is the whole point: a model released an
// hour ago has no entry anywhere, and these are enough to build a usable pick without a code change.
const PROVIDER_DEFAULTS: Record<LlmSecretProvider, Omit<CatalogModel, "label">> = {
  deepseek: { contextTokens: 128_000, supportsTools: true, supportsJsonFormat: true, supportsTemperature: true },
  openai: { contextTokens: 128_000, supportsTools: true, supportsJsonFormat: false, supportsTemperature: false },
  anthropic: { contextTokens: 200_000, supportsTools: true, supportsJsonFormat: false, supportsTemperature: false },
  google: { contextTokens: 128_000, supportsTools: true, supportsJsonFormat: false, supportsTemperature: true },
};

const SOURCES: Record<LlmSecretProvider, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
};

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const UNKNOWN_CONTEXT_TOKENS = 128_000;

function keyVar(provider: LlmSecretProvider): SecretVar | undefined {
  return LLM_SECRETS.find((s) => s.provider === provider)?.envVar;
}

export function cloudKey(provider: LlmSecretProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

// A cloud key carries its own provider and model id, so a job that names one can be rebuilt
// without listing anything. That is the difference between a picker that goes blank when a
// provider is unreachable and a running job that keeps going.
export function parseCloudKey(key: string): { provider: LlmSecretProvider; modelId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const provider = key.slice(0, at);
  const known = LLM_SECRETS.some((s) => s.provider === provider);
  const modelId = key.slice(at + 1);
  return known && modelId ? { provider: provider as LlmSecretProvider, modelId } : null;
}

// What each provider's listing last said, kept on disk. resolveLlm rebuilds a cloud def from its
// key alone and has no listing to consult, so without this the picker would show the window the
// provider reported while every job resolved against the fallback — and a book that fits would be
// refused with advice contradicting the number the user just read. Persisted, not just in memory,
// because that disagreement is worst exactly when the process is new: a restart, a probe that
// failed, or models.dev being unreachable all empty an in-memory map and take the real window with
// it, leaving a job to resolve against a per-provider guess.
type Listing = { at: number; ids: Set<string>; meta: Map<string, CatalogModel> };

// How long a listing stays authoritative enough to contradict a saved key. Age matters because the
// two uses want different confidence: last month's numbers still beat a guess, but last month's
// *id set* must not reject a model released since. Past this, a key we cannot place is let through
// to the provider rather than refused here.
const LISTING_TTL_MS = 24 * 60 * 60 * 1000;

let listings: Map<LlmSecretProvider, Listing> | null = null;

function listingFile(): string {
  return path.join(env.DATA_DIR, "provider-listings.json");
}

function loadListings(): Map<LlmSecretProvider, Listing> {
  if (listings) return listings;
  const loaded = new Map<LlmSecretProvider, Listing>();
  try {
    const parsed = JSON.parse(fs.readFileSync(listingFile(), "utf8")) as Record<
      string,
      { at?: unknown; ids?: unknown; meta?: unknown }
    >;
    for (const [provider, entry] of Object.entries(parsed ?? {})) {
      if (typeof entry?.at !== "number" || !Array.isArray(entry.ids)) continue;
      loaded.set(provider as LlmSecretProvider, {
        at: entry.at,
        ids: new Set(entry.ids.filter((id): id is string => typeof id === "string")),
        meta: new Map(Object.entries((entry.meta as Record<string, CatalogModel>) ?? {})),
      });
    }
  } catch {
    // Nothing cached is the ordinary first run, not a failure: every key falls to the permissive
    // branch below until a listing is fetched.
  }
  listings = loaded;
  return loaded;
}

function saveListings(): void {
  const out: Record<string, { at: number; ids: string[]; meta: Record<string, CatalogModel> }> = {};
  for (const [provider, listing] of loadListings()) {
    out[provider] = { at: listing.at, ids: [...listing.ids], meta: Object.fromEntries(listing.meta) };
  }
  try {
    fs.mkdirSync(env.DATA_DIR, { recursive: true });
    fs.writeFileSync(listingFile(), JSON.stringify(out));
  } catch (err) {
    console.error(`Could not cache the provider listings: ${describeError(err)}`);
  }
}

function trustedListing(provider: LlmSecretProvider): Listing | undefined {
  const listing = loadListings().get(provider);
  return listing && Date.now() - listing.at < LISTING_TTL_MS ? listing : undefined;
}

// Whether the provider has actually listed this id. undefined means we cannot say — no listing we
// trust — and the caller must let the provider answer rather than guess either way.
export function cloudModelListed(provider: LlmSecretProvider, modelId: string): boolean | undefined {
  return trustedListing(provider)?.ids.has(modelId);
}

export function cloudDef(provider: LlmSecretProvider, modelId: string, fromListing?: CatalogModel): LlmModelDef {
  // A stale listing is still the best metadata we have, so this lookup is deliberately not the
  // TTL-guarded one the existence check uses: an old window beats a per-provider guess.
  const native = fromListing ?? loadListings().get(provider)?.meta.get(modelId);
  const known = catalogModel(provider, modelId);
  const pick = <T>(of: T | undefined, fallback: T): T => of ?? fallback;
  const label = native?.label ?? known?.label ?? modelId;
  const contextTokens = pick(native?.contextTokens, pick(known?.contextTokens, PROVIDER_DEFAULTS[provider].contextTokens ?? UNKNOWN_CONTEXT_TOKENS));
  const catalogued = known?.contextTokens !== undefined || native?.contextTokens !== undefined;
  return {
    key: cloudKey(provider, modelId),
    label,
    hint: `Listed by ${SOURCES[provider]}`,
    source: SOURCES[provider],
    provider,
    modelId,
    contextTokens,
    // A guessed window must be marked as one: the context guards refuse to skip a book on a number
    // nobody confirmed, because wrongly skipping is worse than letting the provider answer.
    contextAssumed: !catalogued,
    // Only worth saying when the number is a guess — otherwise it just repeats the picker
    contextNote: catalogued ? undefined : `context unconfirmed — assuming ${Math.round(contextTokens / 1000)}k`,
    supportsTemperature: pick(native?.supportsTemperature, pick(known?.supportsTemperature, PROVIDER_DEFAULTS[provider].supportsTemperature ?? false)),
    supportsTools: pick(native?.supportsTools, pick(known?.supportsTools, PROVIDER_DEFAULTS[provider].supportsTools ?? false)),
    supportsJsonFormat: pick(native?.supportsJsonFormat, pick(known?.supportsJsonFormat, PROVIDER_DEFAULTS[provider].supportsJsonFormat ?? false)),
  };
}

type Listed = { modelId: string; native?: CatalogModel };

// What each provider's own listing looks like. Ids come from there because that is the only place
// that knows what a key can actually call: on release day DeepSeek's /models reported
// `deepseek-flash` while every public catalog still listed the previous id.
const LISTINGS: Record<
  LlmSecretProvider,
  { url: string; headers: (apiKey: string) => Record<string, string>; models: (body: unknown) => Listed[]; chat?: (id: string) => boolean }
> = {
  deepseek: {
    url: "https://api.deepseek.com/models",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    models: (body) => idsOf((body as { data?: { id?: unknown }[] })?.data),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    models: (body) => idsOf((body as { data?: { id?: unknown }[] })?.data),
    chat: isChatModel,
  },
  anthropic: {
    // The only listing that reports a context window and capability flags directly
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
    models: (body) =>
      ((body as { data?: Record<string, unknown>[] })?.data ?? []).flatMap((m) => {
        const modelId = typeof m.id === "string" ? m.id : null;
        if (!modelId) return [];
        const capabilities = m.capabilities as Record<string, { supported?: unknown }> | null;
        const supported = (of: string) => {
          const value = capabilities?.[of]?.supported;
          return typeof value === "boolean" ? value : undefined;
        };
        return [
          {
            modelId,
            native: {
              label: typeof m.display_name === "string" ? m.display_name : modelId,
              contextTokens: typeof m.max_input_tokens === "number" && m.max_input_tokens > 0 ? m.max_input_tokens : undefined,
              supportsTools: true,
              supportsJsonFormat: supported("structured_outputs"),
            },
          },
        ];
      }),
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: (apiKey) => ({ "x-goog-api-key": apiKey }),
    models: (body) =>
      ((body as { models?: Record<string, unknown>[] })?.models ?? []).flatMap((m) => {
        const name = typeof m.name === "string" ? m.name.replace(/^models\//, "") : null;
        if (!name) return [];
        return [
          {
            modelId: name,
            native: {
              label: typeof m.displayName === "string" ? m.displayName : name,
              contextTokens: typeof m.inputTokenLimit === "number" && m.inputTokenLimit > 0 ? m.inputTokenLimit : undefined,
            },
          },
        ];
      }),
  },
};

function idsOf(entries: { id?: unknown }[] | undefined): Listed[] {
  return (entries ?? []).flatMap((e) => (typeof e.id === "string" ? [{ modelId: e.id }] : []));
}

// The families in OpenAI's listing that cannot answer a chat completion. A deny-list of model
// kinds rather than an allow-list of names: kinds change rarely, names every few weeks.
const NON_CHAT = /embedding|whisper|tts|dall-e|moderation|transcribe|realtime|computer-use|^sora|^davinci|^babbage|image|audio/i;
function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

// Google filters on the generation methods instead of the name — the model itself says whether it
// can do generateContent, which is what a chat call needs.
function googleChatIds(body: unknown): Set<string> | null {
  const models = (body as { models?: Record<string, unknown>[] })?.models;
  if (!models) return null;
  return new Set(
    models.flatMap((m) => {
      const name = typeof m.name === "string" ? m.name.replace(/^models\//, "") : null;
      const methods = m.supportedGenerationMethods;
      return name && Array.isArray(methods) && methods.includes("generateContent") ? [name] : [];
    }),
  );
}

async function probe(provider: LlmSecretProvider): Promise<Listed[]> {
  const apiKey = env[keyVar(provider) as keyof typeof env] as string | undefined;
  if (!apiKey) return [];
  const listing = LISTINGS[provider];
  try {
    const res = await fetch(listing.url, {
      headers: listing.headers(apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = await res.json();
    if (provider === "google") {
      const chatIds = googleChatIds(body);
      if (chatIds) return listing.models(body).filter((m) => chatIds.has(m.modelId));
    }
    const listed = listing.models(body);
    const chat = listing.chat;
    return chat ? listed.filter((m) => chat(m.modelId)) : listed;
  } catch {
    return [];
  }
}

export type CloudDiscovery = { provider: LlmSecretProvider; source: string; running: boolean; models: LlmModelDef[] };

// modelCatalog is awaited first so the defs below are built against real metadata rather than the
// per-provider fallbacks, which only exist for models no catalog has caught up with yet.
function recordListing(provider: LlmSecretProvider, listed: Listed[]): void {
  const meta = new Map<string, CatalogModel>();
  for (const m of listed) if (m.native) meta.set(m.modelId, m.native);
  loadListings().set(provider, { at: Date.now(), ids: new Set(listed.map((m) => m.modelId)), meta });
  saveListings();
}

async function discoverProvider(provider: LlmSecretProvider): Promise<CloudDiscovery> {
  const server: CloudDiscovery = { provider, source: SOURCES[provider], running: false, models: [] };
  const envVar = keyVar(provider);
  if (!envVar || !isConfigured(envVar)) return server;
  await modelCatalog();
  const listed = await probe(provider);
  // An empty listing is a probe that failed, not a provider that withdrew everything, so it must
  // not be recorded: writing an empty id set would mark every saved key for this provider as one
  // the provider does not have, and the existence check would start refusing real models.
  if (listed.length === 0) return server;
  server.running = true;
  recordListing(provider, listed);
  server.models = listed.map((m) => cloudDef(provider, m.modelId, m.native));
  return server;
}

let cache: { at: number; servers: CloudDiscovery[] } | null = null;
let inFlight: Promise<CloudDiscovery[]> | null = null;
// Bumped whenever the cached answer stops being the answer. A round started before the bump is
// still awaited by whoever asked for it, but it must not write its result: saving a key while a
// probe is in flight would otherwise repopulate the cache with servers that predate the key, and
// the key the user just pasted would look rejected for the rest of the window.
let generation = 0;

// Saving a key is the moment its provider's catalogue becomes worth asking for. Without this the
// array cached while the key was absent stands for the rest of the window, and a key the user just
// pasted looks rejected because none of its models appear.
//
// The listings are dropped too, so "forget what we discovered" means the same thing for the defs
// resolveLlm builds as for the array the picker renders. Writing through the same map means a
// production call re-reads identical content; the reason to do it is that the two caches must not
// be able to disagree about what a provider offers.
export function invalidateCloudDiscovery(): void {
  cache = null;
  listings = null;
  generation += 1;
  // Dropped as well as bumped: this is what a caller joining the promise would otherwise be handed,
  // and it is precisely the round that did not see the change.
  inFlight = null;
}

export async function cloudServers(refresh = false): Promise<CloudDiscovery[]> {
  if (!refresh && cache && Date.now() - cache.at < DISCOVERY_TTL_MS) return cache.servers;
  // A page load asks for the listing from two places in the same tick — the batch dispatches
  // llmModels.list and llmModels.getDefault together — and the cache is written after the await, so
  // without this both would run the full four-provider round. Same trap, same remedy as
  // model-catalog.ts: a promise the second caller joins rather than a second round it starts.
  if (!refresh && inFlight) return inFlight;
  const startedAt = generation;
  const pending = (async () => {
    const servers = await Promise.all(LLM_SECRETS.map((s) => discoverProvider(s.provider)));
    if (startedAt === generation) cache = { at: Date.now(), servers };
    return servers;
  })();
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}
