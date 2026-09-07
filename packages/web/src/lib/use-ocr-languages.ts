import { trpc } from "../trpc.ts";
import type { RouterOutputs } from "../../../server/src/router.ts";

export type OcrLanguage = RouterOutputs["ocrLanguages"]["list"][number];

export function useOcrLanguages() {
  const query = trpc.ocrLanguages.list.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((l) => l.download && !l.download.error) ? 1000 : false),
    staleTime: Infinity,
  });
  return { languages: query.data ?? [], error: query.error, isLoading: query.isLoading };
}

// The pack a book's language needs; English when the language was never set, as the OCR step assumes.
export function packForBookLanguage(languages: OcrLanguage[], iso: string | null): OcrLanguage | null {
  return languages.find((l) => (iso ? l.iso === iso : l.code === "eng")) ?? null;
}
