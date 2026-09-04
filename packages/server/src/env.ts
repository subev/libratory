import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

// Walking up from this file finds the repo when running from source, and finds nothing useful
// once the server is a bundle or a single executable — there, the launcher passes the root in.
const repoRoot = process.env.LIBRATORY_HOME
  ?? (import.meta.dirname ? path.resolve(import.meta.dirname, "../../..") : path.resolve(process.cwd(), "../.."));
// Where the API keys live. Separate from LIBRATORY_HOME so a developer can point the installed
// app at the checkout's .env and stop keeping two copies of the same keys in sync.
export const envFilePath = process.env.LIBRATORY_ENV_FILE ?? path.join(repoRoot, ".env");
dotenv.config({ path: envFilePath });

const envSchema = z.object({
  DATABASE_URL: z.string(),
  DATA_DIR: z.string().default("./data"),
  PORT: z.coerce.number().default(3034),
  // Localhost by default: the desktop app opens a window on the same machine, and a library that
  // answers the whole coffee-shop network is not a default anyone chose.
  HOST: z.string().default("127.0.0.1"),
  // Hostnames a browser may legitimately reach this server by, comma-separated (`host:port` when
  // it is not the default port). Only names need listing — an IP-literal Host is already accepted,
  // because DNS rebinding cannot produce one. Set it when a reverse proxy or an mDNS/tailnet name
  // fronts the server; see lib/cors.ts.
  TRUSTED_HOSTS: z.string().default(""),
  CONDA_ENV_PATH: z.string().default(path.join(repoRoot, ".venv", "bin")),
  SCRIPTS_DIR: z.string().default(path.join(repoRoot, "scripts")),
  WEB_DIR: z.string().default(path.join(repoRoot, "packages", "web", "dist")),
  MIGRATIONS_DIR: z.string().default(path.join(repoRoot, "packages", "server", "drizzle")),
  POCKET_ENV_PATH: z.string().default(path.join(repoRoot, ".venv-pocket", "bin")),
  // Where the vivliostyle CLI is installed when the server has no node_modules of its own.
  VIVLIOSTYLE_DIR: z.string().default(path.join(repoRoot, "vivliostyle")),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  // Settings → "Default AI model": the model key every no-explicit-pick request resolves to.
  // Unset means automatic (V4 Flash when configured, else the first available model).
  DEFAULT_LLM_MODEL: z.string().optional(),
  LOCAL_LLM_URL: z.string().optional(),
  LOCAL_LLM_MODEL: z.string().optional(),
  LOCAL_LLM_LABEL: z.string().optional(),
  LOCAL_LLM_CONTEXT_TOKENS: z.coerce.number().default(32_768),
  LOCAL_LLM_TOOLS: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CARTESIA_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_multilingual_v2"),
  READALOUD_DROP_DIR: z.string().optional(),
});

export const env = envSchema.parse(process.env);
