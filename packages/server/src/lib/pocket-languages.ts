import { POCKET_LANGUAGES, POCKET_SCRIPT, pocketLanguageInstalled, pocketPython, type PocketLanguage } from "./pocket.ts";
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
