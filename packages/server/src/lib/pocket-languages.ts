import {
  DEFAULT_POCKET_LANGUAGE,
  POCKET_LANGUAGES,
  POCKET_SCRIPT,
  pocketCloningAvailable,
  pocketLanguageInstalled,
  pocketPython,
  type PocketLanguage,
} from "./pocket.ts";
import { env, envFilePath } from "../env.ts";
import { DownloadTracker } from "./downloads.ts";

export type PocketLanguageState = {
  code: string;
  label: string;
  approxMb: number;
  realtimeFactor: number;
  note?: string;
  installed: boolean;
  downloading: boolean;
  error: string | null;
};

// Downloads land in the shared HF cache, which the synthesis subprocess reads at spawn time — so a
// finished download is live immediately, with no server restart. In-flight runs are tracked only
// so the UI can show progress; intentionally lost on restart like the extract registry.
const downloads = new DownloadTracker();

export async function listPocketLanguages(): Promise<PocketLanguageState[]> {
  const installed = await Promise.all(POCKET_LANGUAGES.map((l) => pocketLanguageInstalled(l.model)));
  return POCKET_LANGUAGES.map((language, i) => ({
    code: language.code,
    label: language.label,
    approxMb: language.approxMb,
    realtimeFactor: language.realtimeFactor,
    note: language.note,
    installed: installed[i] ?? false,
    downloading: downloads.downloading(language.code),
    error: downloads.error(language.code),
  }));
}

export function startPocketLanguageDownload(language: PocketLanguage): { started: boolean } {
  return downloads.start(language.code, pocketPython(), [POCKET_SCRIPT, "--cache-only", "--language", language.model]);
}

const CLONING = "cloning";

export async function pocketCloningState() {
  return {
    available: await pocketCloningAvailable(),
    tokenSet: Boolean(env.HF_TOKEN),
    downloading: downloads.downloading(CLONING),
    error: downloads.error(CLONING),
    envFile: envFilePath,
  };
}

// The English checkpoint from the gated repo is what carries the cloning weights; with HF_TOKEN in
// the environment the cache step tries that repo first, and --require-cloning turns its silent
// fallback to the mirror into the error the user needs to see.
export function startPocketCloningDownload(): { started: boolean } {
  if (!env.HF_TOKEN) throw new Error(`Set HF_TOKEN in ${envFilePath} and restart Libratory first`);
  return downloads.start(CLONING, pocketPython(), [POCKET_SCRIPT, "--cache-only", "--require-cloning", "--language", DEFAULT_POCKET_LANGUAGE.model]);
}
