import { memo, useCallback, useEffect, useRef, useState } from "react";
import { SHOW_ALL_MODELS, collapsibleModels, useDefaultModelKey, useLlmModels } from "../lib/use-llm-models.ts";
import { formatTokens } from "../lib/ai-presets.ts";
import { Dropdown } from "./Dropdown.tsx";
import type { LlmModel } from "../lib/use-llm-models.ts";

export const ModelPicker = memo(function ModelPicker({
  value,
  onChange,
  requireTools = false,
  testId,
  placement,
}: {
  value: string;
  onChange: (key: string) => void;
  // library chat needs tool calling; models without it stay visible but disabled
  requireTools?: boolean;
  testId: string;
  // A picker in a modal's footer opens upward: the panel clips whatever hangs below it
  placement?: "below" | "above";
}) {
  const models = useLlmModels();
  const { key: defaultKey, pending: defaultPending } = useDefaultModelKey();
  const [showAll, setShowAll] = useState(false);
  const usable = useCallback(
    (key: string) => {
      const m = models.find((entry) => entry.key === key);
      return m !== undefined && (!requireTools || m.supportsTools);
    },
    [models, requireTools],
  );

  // Callers mount with value "" (unresolved): land on the default model, or the first usable one
  // when the default is missing or can't do what this picker needs (e.g. chat tools).
  //
  // `onChange` is deliberately not a dependency, and the emitted key is remembered. Callers pass an
  // inline arrow, so its identity changes every render; when the change is persisted through the
  // server, `value` stays unusable for the whole round-trip, and an effect that re-runs on every
  // render fires the mutation again on each one. That is a render loop that ends in React #185 and
  // a white page, which is exactly how it was found.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const emitted = useRef<string | null>(null);

  useEffect(() => {
    if (models.length === 0 || defaultPending || usable(value)) return;
    const fallback = defaultKey && usable(defaultKey) ? defaultKey : models.find((m) => !requireTools || m.supportsTools)?.key;
    if (!fallback || emitted.current === fallback) return;
    emitted.current = fallback;
    latest.current(fallback);
  }, [models, value, requireTools, defaultKey, defaultPending, usable]);

  const active = models.find((m) => m.key === value);
  const option = (m: LlmModel) => {
    const noTools = requireTools && !m.supportsTools;
    return {
      value: m.key,
      label: `${m.label}${noTools ? " (no chat tools)" : ""}`,
      hint: `${m.hint} · ${formatTokens(m.contextTokens)} context`,
      disabled: noTools,
      group: m.source,
    };
  };
  const { shown, hidden } = collapsibleModels(models, value, showAll);
  return (
    <Dropdown
      value={active?.key ?? ""}
      onChange={(next) => (next === SHOW_ALL_MODELS ? setShowAll(true) : onChange(next))}
      options={[
        ...shown.map(option),
        ...(hidden > 0 ? [{ value: SHOW_ALL_MODELS, label: `Show all ${models.length} models`, group: "" }] : []),
      ]}
      placeholder={models.length === 0 ? "No AI model available" : "Choose a model"}
      disabled={models.length === 0}
      width="w-80"
      placement={placement}
      testId={testId}
    />
  );
});
