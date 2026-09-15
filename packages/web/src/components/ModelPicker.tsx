import { memo, useEffect, useRef, useState } from "react";
import { SHOW_ALL_MODELS, collapsibleModels, fallbackModelKey, useDefaultModelKey, useLlmModels } from "../lib/use-llm-models.ts";
import { formatTokens } from "../lib/ai-presets.ts";
import { Dropdown } from "./Dropdown.tsx";
import type { LlmModel } from "../lib/use-llm-models.ts";

export const ModelPicker = memo(function ModelPicker({
  value,
  onChange,
  requireTools = false,
  requireVision = false,
  testId,
  placement,
}: {
  value: string;
  onChange: (key: string) => void;
  // library chat needs tool calling; models without it stay visible but disabled
  requireTools?: boolean;
  // the AI OCR engine needs image input; only a model known not to have it is disabled
  requireVision?: boolean;
  testId: string;
  // A picker in a modal's footer opens upward: the panel clips whatever hangs below it
  placement?: "below" | "above";
}) {
  const models = useLlmModels();
  const { key: defaultKey, pending: defaultPending } = useDefaultModelKey();
  const [showAll, setShowAll] = useState(false);
  // Callers mount with value "" (unresolved): land on the default model, or the first usable one
  // when the default is missing or can't do what this picker needs (e.g. chat tools). A picker
  // that mounts with a value already in hand is left alone — see fallbackModelKey.
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
    if (defaultPending) return;
    const fallback = fallbackModelKey(models, value, defaultKey, requireTools, requireVision);
    if (!fallback || emitted.current === fallback) return;
    emitted.current = fallback;
    latest.current(fallback);
  }, [models, value, requireTools, requireVision, defaultKey, defaultPending]);

  const active = models.find((m) => m.key === value);
  // A stored key the list does not carry still needs a row to sit on, or the trigger reads as
  // unset while a model is very much stored. Shown, never emitted — see the effect above.
  const stored = value !== "" && active === undefined ? value : null;
  const option = (m: LlmModel) => {
    const noTools = requireTools && !m.supportsTools;
    const noVision = requireVision && m.vision === false;
    return {
      value: m.key,
      label: `${m.label}${noTools ? " (no chat tools)" : noVision ? " (cannot read images)" : ""}`,
      hint: `${m.hint} · ${formatTokens(m.contextTokens)} context`,
      disabled: noTools || noVision,
      group: m.source,
    };
  };
  const { shown, hidden } = collapsibleModels(models, value, showAll);
  return (
    <Dropdown
      // The raw value, not active?.key: when the list does not carry the stored key those two
      // disagree, and passing "" leaves the trigger reading "Choose a model" — and the stored row
      // unhighlighted — while a model is stored and jobs are running on it.
      value={value}
      onChange={(next) => (next === SHOW_ALL_MODELS ? setShowAll(true) : onChange(next))}
      options={[
        ...(stored ? [{ value: stored, label: `${stored} (not available right now)`, group: "" }] : []),
        ...shown.map(option),
        ...(hidden > 0 ? [{ value: SHOW_ALL_MODELS, label: `Show all ${models.length} models`, group: "", keepOpen: true }] : []),
      ]}
      placeholder={models.length === 0 ? "No AI model available" : "Choose a model"}
      disabled={models.length === 0}
      width="w-80"
      placement={placement}
      testId={testId}
    />
  );
});
