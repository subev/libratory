import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.ts";
import { TRANSLATION_LANGUAGES } from "../lib/languages.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Button } from "./Button.tsx";

type ChapterSummary = { id: string; index: number; title: string };

type Draft = {
  presetId?: string;
  prompt: string;
  label: string;
};

export function VariantModal({
  bookId,
  chapters,
  initialKey,
  initialChapterId,
  onClose,
}: {
  bookId: string;
  chapters: ChapterSummary[];
  initialKey: string | null;
  initialChapterId?: string | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [activeKey, setActiveKey] = useState<string | null>(initialKey ?? "Bulgarian");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [model, setModel] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(initialChapterId ?? chapters[0]?.id ?? null);
  const outputPane = useRef<HTMLDivElement>(null);
  const selectedChapterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedChapterRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const { data: presets = [] } = trpc.variants.presets.useQuery();
  const { data: lanes = [] } = trpc.variants.list.useQuery({ bookId });

  const { data: bookList = [] } = trpc.variants.listForBook.useQuery(
    { bookId, key: activeKey! },
    {
      enabled: !!activeKey,
      refetchInterval: (query) =>
        query.state.data?.some((t) => t.status === "pending" || t.status === "translating") ? 2000 : false,
    },
  );

  const { data: chapter } = trpc.chapters.get.useQuery(
    { id: selectedId! },
    { enabled: !!selectedId },
  );

  const { data: variant } = trpc.variants.get.useQuery(
    { chapterId: selectedId!, key: activeKey! },
    {
      enabled: !!selectedId && !!activeKey,
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        return s === "pending" || s === "translating" ? 1000 : false;
      },
    },
  );

  const refresh = useCallback(() => {
    utils.variants.get.invalidate();
    utils.variants.listForBook.invalidate();
    utils.variants.list.invalidate();
  }, [utils]);
  const startMutation = trpc.variants.start.useMutation({ onSuccess: refresh });
  const createMutation = trpc.variants.createTransform.useMutation({
    onSuccess: (row) => {
      if (row) setActiveKey(row.key);
      refresh();
    },
  });
  const stopMutation = trpc.variants.stop.useMutation({ onSuccess: refresh });

  const activeLane = activeKey ? lanes.find((l) => l.key === activeKey) ?? null : null;
  const activePreset = activeKey ? presets.find((p) => p.id === activeKey) ?? null : null;
  const isTranslationTarget = draft
    ? false
    : activeLane
      ? activeLane.kind === "translation"
      : !activePreset;
  const targetLabel = draft
    ? (draft.label || (draft.presetId ? presets.find((p) => p.id === draft.presetId)?.label ?? draft.presetId : "Custom"))
    : activeLane
      ? activeLane.label ?? activeLane.key
      : activePreset?.label ?? activeKey ?? "";

  // The select encodes its target: existing lane, language, preset, or a custom prompt
  const selectValue = draft
    ? (draft.presetId ? `preset:${draft.presetId}` : "custom")
    : activeKey
      ? (activeLane ? `lane:${activeKey}` : activePreset ? `preset:${activeKey}` : `lang:${activeKey}`)
      : "custom";

  const handleTargetChange = (value: string) => {
    if (value === "custom") {
      setActiveKey(null);
      setDraft({ prompt: "", label: "" });
    } else if (value.startsWith("preset:")) {
      const preset = presets.find((p) => p.id === value.slice(7));
      if (!preset) return;
      setActiveKey(preset.id);
      setDraft({ presetId: preset.id, prompt: preset.prompt, label: preset.label });
    } else {
      setActiveKey(value.slice(5));
      setDraft(null);
    }
  };

  const running = variant?.status === "pending" || variant?.status === "translating";

  const [live, setLive] = useState<{ id: string; text: string; thinking: string } | null>(null);
  const variantId = running ? variant?.id : undefined;

  useEffect(() => {
    if (!variantId) return;
    const source = new EventSource(`/translations/${variantId}/stream`);
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as
        | { type: "snapshot"; text: string }
        | { type: "delta"; text: string }
        | { type: "thinking"; text: string }
        | { type: "status"; status: string };
      if (event.type === "snapshot") {
        setLive({ id: variantId, text: event.text, thinking: "" });
      } else if (event.type === "delta") {
        setLive((prev) =>
          prev?.id === variantId
            ? { id: variantId, text: prev.text + event.text, thinking: "" }
            : prev,
        );
      } else if (event.type === "thinking") {
        setLive((prev) =>
          prev?.id === variantId
            ? { id: variantId, text: prev.text, thinking: prev.thinking + event.text }
            : prev,
        );
      } else {
        source.close();
        refresh();
      }
    };
    // A re-run keeps the row's id, so the previous run's text is dropped as this one is torn down
    return () => {
      source.close();
      setLive(null);
    };
  }, [variantId, refresh]);

  const liveState = running && live && live.id === variant?.id ? live : null;
  const displayText = liveState?.text ?? variant?.text;
  const thinking = liveState?.thinking ?? "";

  useEffect(() => {
    if (running && outputPane.current) {
      outputPane.current.scrollTop = outputPane.current.scrollHeight;
    }
  }, [displayText, thinking, running]);

  const sourceText = chapter ? chapter.customText ?? chapter.cleanText ?? chapter.rawText : "";
  const statusByChapter = new Map(bookList.map((t) => [t.chapterId, t]));

  // Editing a preset/custom prompt means a fresh run; an untouched draft reuses the stored lane
  const promptEdited = !!draft && (!variant || variant.prompt !== draft.prompt);
  const canStart = !!selectedId && !running &&
    (draft ? draft.prompt.trim().length > 0 : !!activeKey) &&
    !startMutation.isPending && !createMutation.isPending;

  const startLabel =
    !variant || promptEdited
      ? (isTranslationTarget ? "Translate" : "Run")
      : variant.status === "suspended" ? "Resume"
      : variant.status === "failed" ? "Retry"
      : variant.status === "done" ? (isTranslationTarget ? "Re-translate" : "Re-run")
      : (isTranslationTarget ? "Translate" : "Run");

  const handleStart = () => {
    if (!selectedId) return;
    if (draft && (promptEdited || !variant)) {
      createMutation.mutate({
        chapterId: selectedId,
        presetId: draft.presetId,
        prompt: draft.prompt,
        label: draft.presetId ? undefined : draft.label.trim() || undefined,
        thinking: thinkingEnabled,
        model,
      });
    } else if (activeKey) {
      startMutation.mutate({
        chapterId: selectedId,
        key: activeKey,
        restart: variant?.status === "done",
        thinking: thinkingEnabled,
        model,
      });
    }
  };

  const mutationError = startMutation.error ?? createMutation.error ?? stopMutation.error;

  return (
    <Modal size="full" onClose={onClose} backdropTestId="translation-modal">
      <ModalHeader title="Translate / Transform" onClose={onClose}>
        <select
          value={selectValue}
          onChange={(e) => handleTargetChange(e.target.value)}
          disabled={running}
          title={running ? "Stop the running job before switching target" : "Target language or rewrite"}
          className="px-2 py-1 rounded-md border border-(--border) bg-(--bg-card) text-sm text-(--text-primary) disabled:opacity-50"
          data-testid="translation-language"
        >
          {lanes.length > 0 && (
            <optgroup label="In this book">
              {lanes.map((l) => (
                <option key={l.key} value={`lane:${l.key}`}>{l.label ?? l.key} ({l.done}/{chapters.length})</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Translate to">
            {TRANSLATION_LANGUAGES.filter((l) => !lanes.some((x) => x.key === l)).map((l) => (
              <option key={l} value={`lang:${l}`}>{l}</option>
            ))}
          </optgroup>
          <optgroup label="Rewrite as">
            {presets.filter((p) => !lanes.some((x) => x.key === p.id)).map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>{p.label}</option>
            ))}
            <option value="custom">Custom prompt...</option>
          </optgroup>
        </select>

        <label
          className={`flex items-center gap-1.5 text-sm text-(--text-secondary) select-none ${running ? "opacity-50" : "cursor-pointer"}`}
          title="Let the model reason before writing — can improve tricky passages but is several times slower"
        >
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(e) => setThinkingEnabled(e.target.checked)}
            disabled={running}
            data-testid="translation-thinking-toggle"
          />
          Reasoning
        </label>

        <ModelPicker value={model} onChange={setModel} testId="variant-model" />

        <Button
          variant="primary"
          onClick={handleStart}
          disabled={!canStart}
          title={
            !selectedId ? "Select a chapter" :
            running ? `${targetLabel} is running` :
            draft && !draft.prompt.trim() ? "Write a prompt first" :
            variant?.status === "suspended" && !promptEdited ? "Continue from where it stopped" :
            variant?.status === "done" && !promptEdited ? "Discard this text and generate it again" :
            isTranslationTarget ? "Translate this chapter" : "Rewrite this chapter"
          }
          data-testid="translation-start"
        >
          {startLabel}
        </Button>
        <Button
          onClick={() => selectedId && activeKey && stopMutation.mutate({ chapterId: selectedId, key: activeKey })}
          disabled={!selectedId || !running || stopMutation.isPending}
          title={running ? "Stop and keep everything generated so far" : "Nothing is running"}
          data-testid="translation-stop"
        >
          Stop
        </Button>

        {running ? (
          <span className="text-sm text-(--accent-text)" data-testid="translation-progress">
            {thinking ? "Thinking" : isTranslationTarget ? "Translating" : "Rewriting"}{variant?.progress ? ` · ${variant.progress} chunks` : ""}...
          </span>
        ) : variant?.status === "suspended" ? (
          <span className="text-sm text-(--text-muted)">
            Stopped{variant.progress ? ` at ${variant.progress} chunks` : ""} — partial kept
          </span>
        ) : variant?.status === "failed" ? (
          <span className="text-sm text-(--danger-text) truncate" title={variant.error ?? undefined}>
            Failed: {variant.error}
          </span>
        ) : null}
        {mutationError ? (
          <span className="text-sm text-(--danger-text) truncate">{mutationError.message}</span>
        ) : null}
      </ModalHeader>

      {draft ? (
        <div className="flex items-start gap-3 px-4 py-3 border-b border-(--border) bg-(--bg-subtle)" data-testid="transform-prompt-panel">
          {!draft.presetId && (
            <input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Name (optional — inferred if empty)"
              className="w-56 shrink-0 px-2 py-1.5 rounded-md border border-(--border-input) bg-(--bg-card) text-sm text-(--text-primary)"
              data-testid="transform-label"
            />
          )}
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            placeholder="How should each chapter be rewritten? e.g. Explain everything like I'm five, keeping the chapter's structure."
            rows={3}
            className="flex-1 px-2 py-1.5 rounded-md border border-(--border-input) bg-(--bg-card) text-sm text-(--text-primary) resize-y font-mono leading-snug"
            data-testid="transform-prompt"
          />
        </div>
      ) : null}

      <div className="flex-1 flex min-h-0">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-(--border) p-2">
          {chapters.map((ch) => {
            const t = statusByChapter.get(ch.id);
            // button-ok: a chapter list row selecting what the pane shows, not an action
            return (
              <button
                key={ch.id}
                ref={selectedId === ch.id ? selectedChapterRef : undefined}
                onClick={() => setSelectedId(ch.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-(--bg-subtle) ${
                  selectedId === ch.id ? "bg-(--bg-selected)" : ""
                }`}
              >
                <span className="shrink-0 text-xs font-mono text-(--text-faint) w-6 text-right">{ch.index + 1}.</span>
                <span className="flex-1 truncate text-(--text-primary)" title={ch.title}>{ch.title}</span>
                {t ? (
                  <span
                    className={`shrink-0 h-2 w-2 rounded-full ${
                      t.status === "done" ? "bg-(--success)" :
                      t.status === "translating" || t.status === "pending" ? "bg-(--accent) animate-pulse" :
                      t.status === "suspended" ? "bg-(--warning)" :
                      "bg-(--danger)"
                    }`}
                    title={`${t.status}${t.progress ? ` (${t.progress})` : ""}`}
                  />
                ) : null}
              </button>
            );
          })}
          {chapters.length === 0 ? (
            <p className="text-sm text-(--text-muted) p-2">No chapters yet.</p>
          ) : null}
        </div>

        <div className="flex-1 min-w-0 flex flex-col border-r border-(--border)">
          <h3 className="shrink-0 px-4 pt-3 pb-1 text-xs font-medium text-(--text-muted) uppercase tracking-wider">
            Original
          </h3>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <p className="text-sm text-(--text-primary) whitespace-pre-wrap leading-relaxed">
              {sourceText || (selectedId ? "Loading..." : "Select a chapter.")}
            </p>
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="shrink-0 px-4 pt-3 pb-1 text-xs font-medium text-(--text-muted) uppercase tracking-wider">
            {targetLabel}
          </h3>
          <div ref={outputPane} className="flex-1 overflow-y-auto px-4 pb-4">
            <p className="text-sm text-(--text-primary) whitespace-pre-wrap leading-relaxed" data-testid="translation-text">
              {displayText || (thinking ? null : (
                <span className="text-(--text-muted)">
                  {running ? "Waiting for the first chunk..." : "Nothing generated yet."}
                </span>
              ))}
            </p>
            {thinking ? (
              <p
                className="mt-3 text-xs text-(--text-faint) italic whitespace-pre-wrap leading-relaxed"
                data-testid="translation-thinking"
              >
                {thinking}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
