import { useState } from "react";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ModelBundleNotice, useModelBundle } from "./ModelBundleNotice.tsx";

export function BilingualSelection({ bookId, chapterIds, translationKey, onClose }: {
  bookId: string; chapterIds: string[]; translationKey: string; onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const input = { bookId, chapterIds, key: translationKey };
  const [model, setModel] = useState("");
  const { ready } = useModelBundle("search");
  const selection = trpc.bilingual.selection.useQuery(input, {
    refetchInterval: (query) => query.state.data?.some((row) => row.status?.busy) ? 2000 : false,
  });
  const refresh = () => Promise.all([utils.bilingual.selection.invalidate(input), utils.bilingual.status.invalidate()]);
  const prepare = trpc.bilingual.prepareSelection.useMutation({ onSuccess: refresh });
  const cancel = trpc.bilingual.cancelSelection.useMutation({ onSuccess: refresh });
  const rows = selection.data ?? [];
  const active = rows.filter((row) => row.status?.busy).length;
  const missing = rows.filter((row) => row.available && row.status && !row.status.current && !row.status.busy).length;
  const eligible = rows.flatMap((row) => row.status?.current && !row.status.busy && !row.status.linkError && row.status.batches > 0 ? [row.status] : []);
  const batches = eligible.reduce((sum, status) => sum + status.batches, 0);
  const inputTokens = eligible.reduce((sum, status) => sum + status.estimatedInputTokens, 0);
  const submitting = prepare.isPending || cancel.isPending;
  const error = selection.error?.message ?? prepare.error?.message ?? cancel.error?.message;
  const failures = new Map(prepare.data?.filter((result) => result.error).map((result) => [result.chapterId, result.error]));

  return <Modal size="md" onClose={onClose} testId="bilingual-selection">
    <ModalHeader title="Bilingual reading" subtitle={`${chapterIds.length} selected chapters · ${translationKey}`} onClose={onClose} />
    <div className="flex min-h-0 flex-col gap-4 p-4">
      <div className="shrink-0 space-y-4">
      <p className="text-sm text-(--text-secondary)">Prepare the existing text. Narration is optional and runs separately. Completed work is kept; only missing work is requested.</p>
      <ModelBundleNotice id="search" verb="Pairing sentences" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!ready || missing === 0 || submitting} title={!ready ? "Install the local search model to pair sentences" : "Pair only missing or stale selected chapters; current pairs are kept"} onClick={() => prepare.mutate({ ...input, stage: "pairs" })}>
          Pair missing sentences ({missing})
        </Button>
        {active > 0 && <Button size="sm" disabled={submitting} onClick={() => cancel.mutate(input)}>Stop preparation ({active})</Button>}
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker value={model} onChange={setModel} testId="bilingual-selection-model" />
          <Button size="sm" disabled={!model || eligible.length === 0 || submitting} title={!model ? "Choose a model first" : "Request only missing links in currently paired chapters"} onClick={() => prepare.mutate({ ...input, stage: "links", model })}>
            Link remaining words ({eligible.length})
          </Button>
        </div>
        <p className="text-xs text-(--text-muted)">{batches} remaining batches · roughly {inputTokens.toLocaleString()} input tokens, up to {(batches * 8192).toLocaleString()} output tokens. Uses the selected model; cloud providers may charge. Failed work runs again only when requested.</p>
      </div>
      {error && <p role="alert" className="text-sm text-(--danger-text)">{error}</p>}
      {selection.isPending && <p role="status" className="text-sm">Checking preparation…</p>}
      </div>
      <ul className="min-h-0 overflow-y-auto divide-y divide-(--border) text-sm">
        {rows.map((row) => {
          const status = row.status;
          const jobs = [status?.pairJob, status?.linkJob];
          const running = jobs.find((job) => job?.status === "running" || job?.status === "queued");
          const failed = failures.get(row.chapterId) ?? jobs.find((job) => job?.status === "failed")?.error ?? status?.linkError;
          return <li key={row.chapterId} className="py-2 space-y-1" data-testid="bilingual-selection-chapter">
            <div className="flex items-start justify-between gap-3">
              <span>{row.index + 1}. {row.title}</span>
              <Button size="sm" variant="ghost" disabled={!status?.current} title={status?.current ? "Open bilingual reader" : "Pair this chapter first"} to={`/books/${bookId}/read?${new URLSearchParams({ chapter: String(row.index), with: translationKey })}`}>Read</Button>
            </div>
            <p className="text-xs text-(--text-muted)">
              {running ? `${running.status} · ${running.done}/${running.total}` : !row.available || !status ? "Needs completed translation and source text" : status.current ? `${status.pairs} sentence groups · ${status.linked}/${status.matched} with word links` : "Sentence pairing needed"}
              {!running && jobs.some((job) => job?.status === "cancelled") ? " · stopped" : ""}
            </p>
            {failed && <p role="alert" className="text-xs text-(--danger-text)">{failed}</p>}
          </li>;
        })}
      </ul>
      <p className="shrink-0 text-xs text-(--text-muted)">Preparation continues when this panel is closed. Export from the original-language view to include prepared translations.</p>
    </div>
  </Modal>;
}
