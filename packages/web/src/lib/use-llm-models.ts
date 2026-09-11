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
export function useDefaultModelKey(): { key: string | null; pending: boolean } {
  const { data, isPending } = trpc.llmModels.getDefault.useQuery(undefined, { staleTime: 5 * 60 * 1000 });
  return { key: data?.resolved ?? null, pending: isPending };
}

// What a request with no explicit pick runs on, and the Settings pick it stepped over when that
// model's server is down — the rule itself lives on the server, in modelChoice.
export function useRunModel(enabled = true): { label: string | null; steppedOver: string | null } {
  const { data } = trpc.llmModels.getDefault.useQuery(undefined, { staleTime: 5 * 60 * 1000, enabled });
  return { label: data?.resolvedLabel ?? null, steppedOver: data?.steppedOver ?? null };
}

export function useActiveLlmModel(key: string): LlmModel | undefined {
  const models = useLlmModels();
  const { key: defaultKey } = useDefaultModelKey();
  return models.find((m) => m.key === key) ?? models.find((m) => m.key === defaultKey) ?? models[0];
}

// A provider's catalogue is long — OpenAI alone lists 50-odd ids, embeddings and tts among them.
// Both the model picker and the Settings default dropdown show the curated picks plus whatever is
// currently selected, and keep the rest behind one row. Shared here so the two agree.
export const SHOW_ALL_MODELS = "__all__";

export function collapsibleModels(
  models: LlmModel[],
  value: string,
  showAll: boolean,
): { shown: LlmModel[]; hidden: number } {
  // The current value is always kept, however long the list: without it the trigger would read
  // as unset, because Dropdown looks its label up among the options it was handed.
  if (showAll) return { shown: models, hidden: 0 };
  const shown = models.filter((m) => m.recommended || m.key === value);
  return { shown, hidden: models.length - shown.length };
}

// Which model a picker mounting on `value` should fall back to, or undefined to leave it alone.
//
// Only an unresolved picker is filled in. A saved pick is never silently replaced: a provider's
// listing can fail transiently — a probe times out, a key 401s for one window — and rewriting a
// book's stored model because of that is worse than leaving what is actually stored on screen.
// The server reports genuine substitutions through modelChoice's steppedOver instead.
export function fallbackModelKey(
  models: LlmModel[],
  value: string,
  defaultKey: string | null,
  requireTools: boolean,
): string | undefined {
  if (value !== "" || models.length === 0) return undefined;
  const usable = (key: string) => {
    const model = models.find((entry) => entry.key === key);
    return model !== undefined && (!requireTools || model.supportsTools);
  };
  if (defaultKey && usable(defaultKey)) return defaultKey;
  return models.find((m) => !requireTools || m.supportsTools)?.key;
}
