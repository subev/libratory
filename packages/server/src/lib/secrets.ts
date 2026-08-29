import { env, envFilePath } from "../env.ts";
import { updateEnvFile } from "./env-file.ts";

// Every key a user can paste in rather than having to edit a file. The desktop app has no
// checkout and no shell, so anything absent from this table is unreachable to the people it was
// built for — CARTESIA_API_KEY and ELEVENLABS_API_KEY were, for exactly that reason.
type LlmSecret = { envVar: keyof typeof env; label: string; kind: "llm"; provider: LlmSecretProvider };
type VoiceSecret = { envVar: keyof typeof env; label: string; kind: "voice"; note: string };

export type LlmSecretProvider = "deepseek" | "openai" | "anthropic" | "google";

export const SECRETS = [
  { envVar: "DEEPSEEK_API_KEY", label: "DeepSeek", kind: "llm", provider: "deepseek" },
  { envVar: "OPENAI_API_KEY", label: "OpenAI", kind: "llm", provider: "openai" },
  { envVar: "ANTHROPIC_API_KEY", label: "Anthropic", kind: "llm", provider: "anthropic" },
  { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", label: "Google Gemini", kind: "llm", provider: "google" },
  {
    envVar: "CARTESIA_API_KEY",
    label: "Cartesia",
    kind: "voice",
    note: "Cloud voices in most languages, billed per character.",
  },
  {
    envVar: "ELEVENLABS_API_KEY",
    label: "ElevenLabs",
    kind: "voice",
    note: "The free tier gives a key and 10,000 characters a month.",
  },
] as const satisfies readonly (LlmSecret | VoiceSecret)[];

export type SecretVar = (typeof SECRETS)[number]["envVar"];

export const SECRET_VARS = SECRETS.map((s) => s.envVar) as [SecretVar, ...SecretVar[]];

export const LLM_SECRETS = SECRETS.filter((s) => s.kind === "llm");

export function isConfigured(envVar: SecretVar): boolean {
  return Boolean(env[envVar]);
}

export function setSecret(envVar: SecretVar, value: string | null): void {
  const cleaned = value?.trim() || null;
  if (cleaned && /[\r\n]/.test(cleaned)) throw new Error("API key must be a single line");
  updateEnvFile(envFilePath, envVar, cleaned);
  env[envVar] = cleaned ?? undefined;
  // Scripts we spawn (scripts/hn-top10.mjs) read the key from the environment they inherit, and
  // a container's LIBRATORY_ENV_FILE is not the `.env` their own fallback looks in.
  if (cleaned) process.env[envVar] = cleaned;
  else delete process.env[envVar];
}

// Every card in Settings comes from here. `notes` supplies the one thing this module cannot know —
// which models an LLM key unlocks — rather than the client fetching a second, far more expensive
// query (llmModels.status probes every local server) to learn the same key's state twice.
export function secretStatus(notes: Partial<Record<SecretVar, string>> = {}) {
  return {
    // "Where does my key go" has a different answer in a checkout and in the app
    path: envFilePath,
    keys: SECRETS.map((s) => {
      const value = env[s.envVar];
      return {
        envVar: s.envVar,
        label: s.label,
        kind: s.kind,
        note: notes[s.envVar] ?? ("note" in s ? s.note : ""),
        configured: Boolean(value),
        // The last four characters: enough to recognise a key without handing it back
        keyHint: value ? `…${value.slice(-4)}` : null,
      };
    }),
  };
}
