import { env } from "../env.ts";
import { LLM_SECRETS, isConfigured, type LlmSecretProvider, type SecretVar } from "./secrets.ts";
import { catalogModel, modelCatalog, type CatalogModel } from "./model-catalog.ts";
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

export function cloudDef(provider: LlmSecretProvider, modelId: string, native?: CatalogModel): LlmModelDef {
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
    return listing.chat ? listed.filter((m) => listing.chat!(m.modelId)) : listed;
  } catch {
    return [];
  }
}

export type CloudDiscovery = { provider: LlmSecretProvider; source: string; running: boolean; models: LlmModelDef[] };

// modelCatalog is awaited first so the defs below are built against real metadata rather than the
// per-provider fallbacks, which only exist for models no catalog has caught up with yet.
async function discoverProvider(provider: LlmSecretProvider): Promise<CloudDiscovery> {
  const server: CloudDiscovery = { provider, source: SOURCES[provider], running: false, models: [] };
  if (!isConfigured(keyVar(provider)!)) return server;
  await modelCatalog();
  const listed = await probe(provider);
  if (listed.length === 0) return server;
  server.running = true;
  server.models = listed.map((m) => cloudDef(provider, m.modelId, m.native));
  return server;
}

let cache: { at: number; servers: CloudDiscovery[] } | null = null;

export async function cloudServers(refresh = false): Promise<CloudDiscovery[]> {
  if (!refresh && cache && Date.now() - cache.at < DISCOVERY_TTL_MS) return cache.servers;
  const servers = await Promise.all(LLM_SECRETS.map((s) => discoverProvider(s.provider)));
  cache = { at: Date.now(), servers };
  return servers;
}
