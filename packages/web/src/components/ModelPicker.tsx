import { memo, useEffect, useRef } from "react";
import { useDefaultModelKey, useLlmModels } from "../lib/use-llm-models.ts";
import { formatTokens } from "../lib/ai-presets.ts";

export const ModelPicker = memo(function ModelPicker({
  value,
  onChange,
  requireTools = false,
  testId,
}: {
  value: string;
  onChange: (key: string) => void;
  // library chat needs tool calling; models without it stay visible but disabled
  requireTools?: boolean;
  testId?: string;
}) {
  const models = useLlmModels();
  const { key: defaultKey, pending: defaultPending } = useDefaultModelKey();
  const usable = (key: string) => {
    const m = models.find((entry) => entry.key === key);
    return m !== undefined && (!requireTools || m.supportsTools);
  };

  // Callers mount with value "" (unresolved): land on the default model, or the first usable one
  // when the default is missing or can't do what this picker needs (e.g. chat tools).
  //
  // `onChange` is deliberately not a dependency, and the emitted key is remembered. Callers pass an
  // inline arrow, so its identity changes every render; when the change is persisted through the
  // server, `value` stays unusable for the whole round-trip, and an effect that re-runs on every
  // render fires the mutation again on each one. That is a render loop that ends in React #185 and
  // a white page, which is exactly how it was found.
  const latest = useRef(onChange);
  latest.current = onChange;
  const emitted = useRef<string | null>(null);

  useEffect(() => {
    if (models.length === 0 || defaultPending || usable(value)) return;
    const fallback = defaultKey && usable(defaultKey) ? defaultKey : models.find((m) => !requireTools || m.supportsTools)?.key;
    if (!fallback || emitted.current === fallback) return;
    emitted.current = fallback;
    latest.current(fallback);
  }, [models, value, requireTools, defaultKey, defaultPending]);

  const active = models.find((m) => m.key === value);
  return (
    <select
      value={active?.key ?? ""}
      onChange={(e) => onChange(e.target.value)}
      title={active?.hint}
      disabled={models.length === 0}
      className="text-sm rounded-md border border-(--border) bg-(--bg-card) text-(--text-primary) px-2 py-1.5 max-w-60 truncate"
      data-testid={testId}
    >
      {models.length === 0 && <option value="">No AI model available</option>}
      {[...new Set(models.map((m) => m.source))].map((source) => (
        <optgroup key={source} label={source}>
          {models
            .filter((m) => m.source === source)
            .map((m) => (
              <option key={m.key} value={m.key} disabled={requireTools && !m.supportsTools} title={`${m.hint} · ${formatTokens(m.contextTokens)} context`}>
                {m.label}
                {requireTools && !m.supportsTools ? " (no chat tools)" : ""}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
});
