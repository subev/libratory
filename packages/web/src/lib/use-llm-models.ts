import { trpc } from "../trpc.ts";
import type { RouterOutputs } from "../../../server/src/router.ts";

export type LlmModel = RouterOutputs["llmModels"]["list"][number];

export function useLlmModels(): LlmModel[] {
  const { data } = trpc.llmModels.list.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  return data ?? [];
}

// The key a request with no explicit pick resolves to — the user's Settings choice when its model
// is available, otherwise the automatic one. `pending` matters: this query and llmModels.list are
// separate round trips, and a picker that read a not-yet-arrived default as "there isn't one" fell
// back to the first model and then had no reason to move.
export function useDefaultModelKey(): { key: string | null; chosen: string | null; pending: boolean } {
  const { data, isPending } = trpc.llmModels.getDefault.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  return { key: data?.resolved ?? null, chosen: data?.chosen ?? null, pending: isPending };
}

// The Settings pick is not what runs when its server is down; every caller that spends money or
// minutes on the automatic choice should be able to say so.
export function useModelFallback(): { chosen: string; using: LlmModel | undefined } | null {
  const models = useLlmModels();
  const { key, chosen } = useDefaultModelKey();
  if (!chosen || !key || chosen === key) return null;
  return { chosen, using: models.find((m) => m.key === key) };
}

export function useActiveLlmModel(key: string): LlmModel | undefined {
  const models = useLlmModels();
  const { key: defaultKey } = useDefaultModelKey();
  return models.find((m) => m.key === key) ?? models.find((m) => m.key === defaultKey) ?? models[0];
}
