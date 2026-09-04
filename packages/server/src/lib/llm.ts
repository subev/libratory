import fs from "node:fs";
import path from "node:path";
import { generateText, streamText, APICallError, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { env, envFilePath } from "../env.ts";
import { updateEnvFile } from "./env-file.ts";
import { LLM_SECRETS, isConfigured, type SecretVar, type LlmSecretProvider } from "./secrets.ts";
import { describeError } from "./errors.ts";

// The cloud providers are whatever secrets.ts says they are; this adds the one that needs no key.
export type LlmProviderKind = LlmSecretProvider | "openai-compatible";

export type LlmModelDef = {
  key: string;
  label: string;
  hint: string;
  // Human-readable origin shown in pickers/settings: "DeepSeek", "Ollama", "LM Studio", ...
  source: string;
  provider: LlmProviderKind;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  contextTokens: number;
  // e.g. "capped at 4k by Ollama" / "loaded at 8k (max 131k)" — shown in settings and tooltips
  contextNote?: string;
  supportsTemperature: boolean;
  supportsTools: boolean;
  // json_object mode is an OpenAI-compatible wire feature
  supportsJsonFormat: boolean;
};

// A key is written to .env as DEFAULT_LLM_MODEL, and applyEnvEdit writes `KEY=value` verbatim, so
// a newline here would be extra env lines. Ollama ids carry "/" and ":" ("ollama:hf.co/u/r:Q4"),
// which is why this rejects the one dangerous character class rather than allowing a charset.
export const modelKeySchema = z.string().min(1).max(64).refine((k) => !/[\r\n]/.test(k), "Model key must be a single line");

const DEEPSEEK_URL = "https://api.deepseek.com";


const CLOUD_MODELS: LlmModelDef[] = [
  {
    key: "flash", source: "DeepSeek", label: "V4 Flash", hint: "Fast and cheap — good default",
    provider: "deepseek", modelId: "deepseek-v4-flash", contextTokens: 1_000_000,
    supportsTemperature: true, supportsTools: true, supportsJsonFormat: true,
  },
  {
    key: "pro", source: "DeepSeek", label: "V4 Pro", hint: "Flagship reasoning model — slower, for harder questions",
    provider: "deepseek", modelId: "deepseek-v4-pro", contextTokens: 1_000_000,
    supportsTemperature: true, supportsTools: true, supportsJsonFormat: true,
  },
  {
    key: "gpt", source: "OpenAI", label: "GPT-5.1", hint: "OpenAI flagship reasoning model",
    provider: "openai", modelId: "gpt-5.1", contextTokens: 256_000,
    supportsTemperature: false, supportsTools: true, supportsJsonFormat: false,
  },
  {
    key: "gpt-mini", source: "OpenAI", label: "GPT-5 Mini", hint: "OpenAI — fast and cheap",
    provider: "openai", modelId: "gpt-5-mini", contextTokens: 256_000,
    supportsTemperature: false, supportsTools: true, supportsJsonFormat: false,
  },
  {
    key: "claude", source: "Anthropic", label: "Claude Opus 5", hint: "Anthropic flagship reasoning model",
    provider: "anthropic", modelId: "claude-opus-5", contextTokens: 1_000_000,
    supportsTemperature: false, supportsTools: true, supportsJsonFormat: false,
  },
  {
    key: "claude-haiku", source: "Anthropic", label: "Claude Haiku 4.5", hint: "Anthropic — fast and cheap",
    provider: "anthropic", modelId: "claude-haiku-4-5", contextTokens: 200_000,
    supportsTemperature: true, supportsTools: true, supportsJsonFormat: false,
  },
  {
    key: "gemini", source: "Google Gemini", label: "Gemini 2.5 Pro", hint: "Google flagship reasoning model",
    provider: "google", modelId: "gemini-2.5-pro", contextTokens: 1_000_000,
    supportsTemperature: true, supportsTools: true, supportsJsonFormat: false,
  },
  {
    key: "gemini-flash", source: "Google Gemini", label: "Gemini 2.5 Flash", hint: "Google — fast and cheap",
    provider: "google", modelId: "gemini-2.5-flash", contextTokens: 1_000_000,
    supportsTemperature: true, supportsTools: true, supportsJsonFormat: false,
  },
];

function openAiCompatModel(def: {
  key: string;
  label: string;
  hint: string;
  source: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  contextTokens: number;
  contextNote?: string;
  supportsTools: boolean;
  supportsJsonFormat?: boolean;
}): LlmModelDef {
  return {
    provider: "openai-compatible",
    supportsTemperature: true,
    supportsJsonFormat: true,
    ...def,
  };
}

const configEntrySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().default("Custom OpenAI-compatible endpoint"),
  baseUrl: z.string().url(),
  modelId: z.string().min(1),
  apiKey: z.string().optional(),
  contextTokens: z.number().int().positive().default(32_768),
  supportsTools: z.boolean().default(false),
  supportsJsonFormat: z.boolean().default(true),
});

let configCache: { mtimeMs: number; models: LlmModelDef[] } | null = null;

function configModels(): LlmModelDef[] {
  const file = path.join(env.DATA_DIR, "llm-models.json");
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (configCache?.mtimeMs === mtimeMs) return configCache.models;
  let models: LlmModelDef[] = [];
  try {
    const entries = z.array(configEntrySchema).parse(JSON.parse(fs.readFileSync(file, "utf8")));
    models = entries.map((e) => openAiCompatModel({ ...e, source: "Custom server" }));
  } catch (err) {
    console.error(`Ignoring invalid ${file}: ${describeError(err)}`);
  }
  configCache = { mtimeMs, models };
  return models;
}

function localEnvModel(): LlmModelDef | undefined {
  if (!env.LOCAL_LLM_URL || !env.LOCAL_LLM_MODEL) return undefined;
  return openAiCompatModel({
    key: "local",
    label: env.LOCAL_LLM_LABEL ?? `Local (${env.LOCAL_LLM_MODEL})`,
    hint: "Runs fully offline on this machine",
    source: "Custom server",
    modelId: env.LOCAL_LLM_MODEL,
    baseUrl: env.LOCAL_LLM_URL,
    contextTokens: env.LOCAL_LLM_CONTEXT_TOKENS,
    supportsTools: env.LOCAL_LLM_TOOLS,
  });
}

function staticModels(): LlmModelDef[] {
  const extras = [localEnvModel(), ...configModels()].filter((m): m is LlmModelDef => m !== undefined);
  const overridden = new Set(extras.map((m) => m.key));
  return [...CLOUD_MODELS.filter((m) => !overridden.has(m.key)), ...extras];
}

// --- Local server auto-discovery: Ollama and LM Studio need no configuration ---

const OLLAMA_URL = "http://localhost:11434";
const LMSTUDIO_URL = "http://localhost:1234";
const PROBE_TIMEOUT_MS = 1_500;
const DISCOVERY_TTL_MS = 30_000;

async function probeJson<T>(url: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(body !== undefined
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type LocalServer = {
  name: "Ollama" | "LM Studio";
  url: string;
  running: boolean;
  startHint: string;
  note?: string;
  models: LlmModelDef[];
};

// Same abbreviation rule as the web's formatTokens, so server-built context notes
// agree with the client-formatted numbers rendered next to them
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

// The serving size is only reported while a model is loaded (/api/ps), and Ollama unloads
// idle models — remember the last observation so the numbers don't regress between requests
let observedOllamaCtx: number | null = null;

async function discoverOllama(): Promise<LocalServer> {
  const server: LocalServer = {
    name: "Ollama",
    url: OLLAMA_URL,
    running: false,
    startHint: "Launch the Ollama app or run `ollama serve`, then `ollama pull <model>`",
    models: [],
  };
  const tags = await probeJson<{ models?: { name: string }[] }>(`${OLLAMA_URL}/api/tags`);
  if (!tags?.models) return server;
  server.running = true;
  // Ollama serves every model at a fixed context and silently truncates beyond it
  // (4k on old versions, 32k on current ones — only /api/ps tells the truth)
  const ps = await probeJson<{ models?: { context_length?: number }[] }>(`${OLLAMA_URL}/api/ps`);
  const observed = ps?.models?.[0]?.context_length;
  if (observed) observedOllamaCtx = observed;
  const servingCtx = observed ?? observedOllamaCtx ?? 4_096;
  const confirmed = observed !== undefined || observedOllamaCtx !== null;
  server.note = confirmed
    ? `Ollama serves ${fmtK(servingCtx)} tokens of context per request (silently truncates beyond it) — raise with the OLLAMA_CONTEXT_LENGTH env or the app's context setting`
    : `Ollama's serving context is unknown until a model loads (assuming a cautious ${fmtK(servingCtx)}; current versions default to 33k) — run one AI action, then Rescan to confirm`;
  type OllamaShow = { capabilities?: string[]; model_info?: Record<string, unknown> };
  const shows = await Promise.all(
    tags.models.map(({ name }) => probeJson<OllamaShow>(`${OLLAMA_URL}/api/show`, { model: name })),
  );
  for (const [i, show] of shows.entries()) {
    const name = tags.models[i]?.name;
    if (!name) continue;
    const capabilities = show?.capabilities ?? [];
    if (capabilities.length > 0 && !capabilities.includes("completion")) continue;
    const arch = show?.model_info?.["general.architecture"];
    const rawMax = typeof arch === "string" ? show?.model_info?.[`${arch}.context_length`] : undefined;
    const modelMax = typeof rawMax === "number" ? rawMax : 8_192;
    server.models.push(
      openAiCompatModel({
        key: `ollama:${name}`,
        label: `${name} (Ollama)`,
        hint: "Runs fully offline on this machine via Ollama",
        source: "Ollama",
        modelId: name,
        baseUrl: `${OLLAMA_URL}/v1`,
        contextTokens: Math.min(modelMax, servingCtx),
        contextNote:
          servingCtx < modelMax
            ? `${confirmed ? "capped at" : "assuming"} ${fmtK(servingCtx)} ${confirmed ? "by Ollama" : "until confirmed"} (model max ${fmtK(modelMax)})`
            : undefined,
        supportsTools: capabilities.includes("tools"),
      }),
    );
  }
  return server;
}

type LmStudioModel = {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
  capabilities?: string[];
};

async function discoverLmStudio(): Promise<LocalServer> {
  const server: LocalServer = {
    name: "LM Studio",
    url: LMSTUDIO_URL,
    running: false,
    startHint: "In LM Studio open the Developer tab and start the server, or run `lms server start`",
    models: [],
  };
  // The v0 REST API carries context/capability details; /v1/models is the fallback for old versions
  let entries: LmStudioModel[];
  const v0 = await probeJson<{ data?: LmStudioModel[] }>(`${LMSTUDIO_URL}/api/v0/models`);
  if (v0?.data) {
    // "vlm" = vision-language model — still a chat model
    entries = v0.data.filter((m) => m.type === "llm" || m.type === "vlm");
  } else {
    const v1 = await probeJson<{ data?: { id: string }[] }>(`${LMSTUDIO_URL}/v1/models`);
    if (!v1?.data) return server;
    entries = v1.data.filter(({ id }) => !/embed/i.test(id));
  }
  server.running = true;
  // LM Studio rejects oversized requests loudly (no silent truncation); when a model is
  // loaded it reports the actual loaded context, otherwise we show the model's max
  server.models = entries.map((m) => {
    const loaded = m.state === "loaded" ? m.loaded_context_length : undefined;
    const max = m.max_context_length ?? 32_768;
    return openAiCompatModel({
      key: `lmstudio:${m.id}`,
      label: `${m.id} (LM Studio)`,
      hint: "Runs fully offline on this machine via LM Studio",
      source: "LM Studio",
      modelId: m.id,
      baseUrl: `${LMSTUDIO_URL}/v1`,
      contextTokens: loaded ?? max,
      contextNote:
        loaded !== undefined && loaded < max
          ? `loaded at ${fmtK(loaded)} (model max ${fmtK(max)}) — raise it in LM Studio's model settings`
          : undefined,
      // LM Studio's /v1 rejects response_format json_object (json_schema/text only)
      supportsJsonFormat: false,
      supportsTools: m.capabilities?.includes("tool_use") ?? false,
    });
  });
  return server;
}

let discoveryCache: { at: number; servers: LocalServer[] } | null = null;

export async function localServers(refresh = false): Promise<LocalServer[]> {
  if (!refresh && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.servers;
  const servers = await Promise.all([discoverOllama(), discoverLmStudio()]);
  discoveryCache = { at: Date.now(), servers };
  return servers;
}

async function discoveredModels(): Promise<LlmModelDef[]> {
  const found = (await localServers()).flatMap((s) => s.models);
  const taken = new Set(staticModels().map((m) => `${m.baseUrl}|${m.modelId}`));
  return found.filter((m) => !taken.has(`${m.baseUrl}|${m.modelId}`));
}

async function allModels(): Promise<LlmModelDef[]> {
  return [...staticModels(), ...(await discoveredModels())];
}

export async function llmStatus() {
  const servers = await localServers(true);
  const statics = staticModels();
  return {
    local: servers.map((s) => ({
      name: s.name,
      url: s.url,
      running: s.running,
      startHint: s.startHint,
      note: s.note ?? null,
      models: s.models.map((m) => ({
        key: m.key,
        label: m.modelId,
        contextTokens: m.contextTokens,
        contextNote: m.contextNote ?? null,
        supportsTools: m.supportsTools,
      })),
    })),
    custom: statics
      .filter((m) => m.provider === "openai-compatible")
      .map((m) => ({ key: m.key, label: m.label, url: m.baseUrl ?? "", modelId: m.modelId })),
  };
}

// What each cloud key unlocks, for the Settings card that offers it. secrets.ts owns whether the
// key is set; this owns what it buys.
export function cloudKeyNotes(): Partial<Record<SecretVar, string>> {
  const statics = staticModels();
  return Object.fromEntries(
    LLM_SECRETS.map((s) => [s.envVar, statics.filter((m) => m.provider === s.provider).map((m) => m.label).join(", ")]),
  );
}

function requiredEnvVar(def: LlmModelDef): SecretVar | undefined {
  return LLM_SECRETS.find((p) => p.provider === def.provider)?.envVar;
}

function isAvailable(def: LlmModelDef): boolean {
  const envVar = requiredEnvVar(def);
  return envVar === undefined || isConfigured(envVar);
}

export async function availableModels(): Promise<LlmModelDef[]> {
  return (await allModels()).filter(isAvailable);
}

// Persisted the way the API keys are, and for the same reason: written to the .env file and
// applied to the in-memory env, so a Settings choice survives a restart without needing one.
export function setDefaultModelKey(key: string | null): void {
  updateEnvFile(envFilePath, "DEFAULT_LLM_MODEL", key);
  env.DEFAULT_LLM_MODEL = key ?? undefined;
}

export async function defaultModelKey(): Promise<string | undefined> {
  const models = await availableModels();
  // The user's pick (Settings → Default AI model) wins while its model is actually available;
  // a stopped Ollama or a removed key falls through to the automatic choice rather than erroring.
  if (env.DEFAULT_LLM_MODEL && models.some((m) => m.key === env.DEFAULT_LLM_MODEL)) {
    return env.DEFAULT_LLM_MODEL;
  }
  return (models.find((m) => m.key === "flash") ?? models[0])?.key;
}

// What a request will actually run on, and the Settings pick it had to step around. A stopped
// LM Studio falls through to a cloud model silently, which is a bill and a different result.
export async function modelChoice(key?: string): Promise<{ key: string | null; label: string; steppedOver?: string }> {
  const wanted = key || (await defaultModelKey()) || null;
  const def = wanted ? (await allModels()).find((m) => m.key === wanted) : undefined;
  const chosen = env.DEFAULT_LLM_MODEL;
  const steppedOver = !key && chosen && chosen !== wanted ? chosen : undefined;
  return { key: wanted, label: def?.label ?? wanted ?? "no model", ...(steppedOver ? { steppedOver } : {}) };
}

// Must match the `name` given to createOpenAICompatible in resolveLlm — the AI SDK
// spreads providerOptions[name] into the request body only under that exact key.
// Dots are stripped because the SDK truncates the name at the first "." when matching,
// which silently dropped all passthrough options for keys like "ollama:llama3.2"
function openAiCompatName(def: LlmModelDef): string {
  return def.provider === "deepseek" ? "deepseek" : def.key.replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function resolveLlm(key?: string): Promise<{ model: LanguageModel; def: LlmModelDef }> {
  // || not ??: a picker that has not resolved yet submits "", which means "the default", not a model
  const wanted = key || (await defaultModelKey());
  if (!wanted) {
    throw new Error(
      "No AI model is available — start Ollama or LM Studio, or add an API key (e.g. DEEPSEEK_API_KEY) to .env",
    );
  }
  // Static entries resolve without probing local servers
  const def = staticModels().find((m) => m.key === wanted) ?? (await discoveredModels()).find((m) => m.key === wanted);
  if (!def) {
    throw new Error(
      wanted.startsWith("ollama:") || wanted.startsWith("lmstudio:")
        ? `Local model "${wanted}" is not available — is its server still running?`
        : `Unknown AI model "${wanted}"`,
    );
  }
  if (!isAvailable(def)) throw new Error(`${def.label} is not configured — set ${requiredEnvVar(def)} in .env`);

  switch (def.provider) {
    case "deepseek":
      return { model: createOpenAICompatible({ name: openAiCompatName(def), baseURL: DEEPSEEK_URL, apiKey: env.DEEPSEEK_API_KEY })(def.modelId), def };
    case "openai-compatible":
      return { model: createOpenAICompatible({ name: openAiCompatName(def), baseURL: def.baseUrl!, apiKey: def.apiKey })(def.modelId), def };
    case "openai":
      return { model: createOpenAI({ apiKey: env.OPENAI_API_KEY })(def.modelId), def };
    case "anthropic":
      return { model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(def.modelId), def };
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY })(def.modelId), def };
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

export type LlmChatOptions = {
  model?: string;
  temperature?: number;
  responseFormat?: "json_object";
  maxTokens?: number;
  timeoutMs?: number;
  allowEmpty?: boolean;
  // DeepSeek-style reasoning toggle; undefined = API default, ignored by providers without it
  thinking?: boolean;
  // Reasoning depth for local OpenAI-compatible servers (LM Studio maps it to the model's
  // thinking levels); huge speedup for structured tasks on slow local decoders
  reasoningEffort?: "low" | "medium" | "high";
};

function extraBody(def: LlmModelDef, opts: LlmChatOptions) {
  const body: {
    thinking?: { type: "enabled" | "disabled" };
    response_format?: { type: "json_object" };
    reasoningEffort?: string;
  } = {};
  if (def.provider === "deepseek" && opts.thinking !== undefined) {
    body.thinking = { type: opts.thinking ? "enabled" : "disabled" };
  }
  if (def.provider === "openai-compatible") {
    // The "Reasoning" toggle maps to effort here: local reasoning models think at full
    // depth by default, which is unusably slow on laptop decode speeds
    const effort = opts.reasoningEffort ?? (opts.thinking === false ? "low" : undefined);
    if (effort) body.reasoningEffort = effort;
  }
  if (def.supportsJsonFormat && opts.responseFormat) body.response_format = { type: opts.responseFormat };
  if (Object.keys(body).length === 0) return undefined;
  return { [openAiCompatName(def)]: body };
}

function callSettings(def: LlmModelDef, opts: LlmChatOptions) {
  const providerOptions = extraBody(def, opts);
  return {
    ...(def.supportsTemperature ? { temperature: opts.temperature ?? (def.provider === "deepseek" ? 1.0 : undefined) } : {}),
    ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function mapError(err: unknown, def: LlmModelDef, signal: AbortSignal, timeoutMs: number): Error {
  if (signal.aborted) return new Error(`${def.label} request timed out after ${timeoutMs / 1000}s`);
  if (APICallError.isInstance(err)) {
    return new Error(`${def.label} API error ${err.statusCode ?? "?"}: ${(err.responseBody ?? err.message).slice(0, 300)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function beginCall(opts: LlmChatOptions) {
  const { model, def } = await resolveLlm(opts.model);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return { model, def, timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
}

function finishCall(raw: string, def: LlmModelDef, opts: LlmChatOptions): string {
  const content = raw.trim();
  if (!content && !opts.allowEmpty) throw new Error(`${def.label} returned an empty response`);
  return content;
}

export async function llmChat(system: string, user: string, opts: LlmChatOptions = {}): Promise<string> {
  const { model, def, timeoutMs, signal } = await beginCall(opts);
  let text: string;
  try {
    const result = await generateText({
      model,
      system,
      prompt: user,
      ...callSettings(def, opts),
      abortSignal: signal,
    });
    text = result.text;
  } catch (err) {
    throw mapError(err, def, signal, timeoutMs);
  }
  return finishCall(text, def, opts);
}

export async function llmChatStream(
  system: string,
  user: string,
  opts: LlmChatOptions & {
    onDelta?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
  } = {},
): Promise<string> {
  const { model, def, timeoutMs, signal } = await beginCall(opts);
  let content = "";
  try {
    const result = streamText({
      model,
      system,
      prompt: user,
      ...callSettings(def, opts),
      abortSignal: signal,
      onError: () => {}, // errors surface as stream parts and are thrown below
    });
    for await (const part of result.stream) {
      if (part.type === "reasoning-delta") opts.onReasoning?.(part.text);
      else if (part.type === "text-delta") {
        content += part.text;
        opts.onDelta?.(part.text);
      } else if (part.type === "error") throw part.error;
      else if (part.type === "abort") throw new Error("aborted");
    }
    if (signal.aborted) throw new Error("aborted");
  } catch (err) {
    throw mapError(err, def, signal, timeoutMs);
  }
  return finishCall(content, def, opts);
}
