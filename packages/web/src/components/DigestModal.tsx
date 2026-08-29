import { useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "../trpc.ts";
import { Modal, ModalHeader } from "./Modal.tsx";
import { DIGEST_LISTENING_PROMPT, DIGEST_PRESETS } from "../lib/ai-presets.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { PillToggle } from "./PillToggle.tsx";
import { Button } from "./Button.tsx";
import { IconWarning } from "./icons.tsx";

export function DigestModal({
  sourceBooks,
  folderId = null,
  onClose,
}: {
  sourceBooks: { id: string; title: string }[];
  folderId?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(`Digest — ${sourceBooks.length} books`);
  const [prompt, setPrompt] = useState(DIGEST_LISTENING_PROMPT);
  const [model, setModel] = useState<string>("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const { data: availability } = trpc.books.textAvailability.useQuery({
    ids: sourceBooks.map((b) => b.id),
  });
  const noText = new Set((availability ?? []).filter((a) => !a.hasText).map((a) => a.id));
  const included = sourceBooks.filter((b) => !excluded.has(b.id));
  const unusable = included.filter((b) => noText.has(b.id));

  const createMutation = trpc.books.createDigest.useMutation({
    onSuccess: (book) => navigate(`/books/${book.id}`),
  });

  function excludeUnusable() {
    setExcluded(new Set([...excluded, ...unusable.map((b) => b.id)]));
  }

  function create() {
    if (!title.trim() || !prompt.trim() || included.length < 2 || createMutation.isPending) return;
    createMutation.mutate({
      title: title.trim(),
      sourceBookIds: included.map((b) => b.id),
      prompt: prompt.trim(),
      model,
      folderId,
    });
  }

  return (
    <Modal size="md" onClose={onClose} testId="digest-modal">
      <ModalHeader title={`Create digest from ${included.length} books`} onClose={onClose} />

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <label className="block text-sm text-(--text-secondary) mb-1">Digest title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-(--border-input) rounded-md bg-(--bg-input) text-(--text-primary)"
            data-testid="digest-title"
          />
        </div>

        <div>
          <label className="block text-sm text-(--text-secondary) mb-1">
            Summary prompt <span className="text-(--text-faint)">— runs once per book; each answer becomes a chapter</span>
          </label>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {DIGEST_PRESETS.map((p) => (
              <PillToggle
                key={p.key}
                selected={prompt === p.prompt}
                onClick={() => setPrompt(p.prompt)}
                testId={`digest-preset-${p.key}`}
              >
                {p.label}
              </PillToggle>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            maxLength={4000}
            className="w-full resize-y rounded-md border border-(--border-input) bg-(--bg-input) p-2.5 text-sm text-(--text-primary) leading-relaxed"
            data-testid="digest-prompt"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-(--text-secondary)">Model</span>
          <ModelPicker value={model} onChange={setModel} testId="digest-model" />
        </div>

        {unusable.length > 0 && (
          <div
            className="rounded-md border border-(--warning) bg-(--warning-bg) p-3 space-y-2"
            data-testid="digest-no-text-warning"
          >
            <p className="text-sm text-(--warning-text)">
              No text available for {unusable.length} book{unusable.length === 1 ? "" : "s"}:{" "}
              {unusable.map((b) => `"${b.title}"`).join(", ")} — the digest would fail. Extract them first
              (with Force OCR if scanned), or leave them out.
            </p>
            <Button
              variant="warning"
              size="sm"
              onClick={excludeUnusable}
              data-testid="digest-exclude-unusable"
            >
              Exclude {unusable.length} book{unusable.length === 1 ? "" : "s"} without text
            </Button>
          </div>
        )}

        <div>
          <p className="text-sm text-(--text-secondary) mb-1">Chapters, in order</p>
          <ol className="text-sm text-(--text-muted) list-decimal pl-5 space-y-0.5">
            {included.map((b) => (
              <li key={b.id} className="truncate" title={b.title}>
                {noText.has(b.id) && <span title="No text available" className="mr-1 inline-flex"><IconWarning className="h-4 w-4" /></span>}
                {b.title}
              </li>
            ))}
          </ol>
          {excluded.size > 0 && (
            <p className="text-xs text-(--text-faint) mt-1">
              {excluded.size} book{excluded.size === 1 ? "" : "s"} without text excluded{" "}
              <button
                onClick={() => setExcluded(new Set())}
                className="underline hover:text-(--text-secondary)"
                data-testid="digest-undo-exclude"
              >
                Undo
              </button>
            </p>
          )}
        </div>

        {createMutation.error && (
          <p className="text-sm text-(--danger-text) whitespace-pre-wrap">{createMutation.error.message}</p>
        )}
      </div>

      <div className="border-t border-(--border) px-4 py-3 shrink-0 flex items-center justify-between gap-3">
        <p className="text-xs text-(--text-faint)">
          Summaries run in the background (~1-2 min per book). Chapters arrive suspended — review, pick a voice, then synthesize.
        </p>
        <Button
          variant="primary"
          className="shrink-0"
          onClick={create}
          disabled={!title.trim() || !prompt.trim() || included.length < 2 || createMutation.isPending}
          title={included.length < 2 ? "A digest needs at least 2 books with text" : undefined}
          data-testid="digest-create"
        >
          {createMutation.isPending ? "Creating..." : "Create digest"}
        </Button>
      </div>
    </Modal>
  );
}
