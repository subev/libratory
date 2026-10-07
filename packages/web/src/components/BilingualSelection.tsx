import { useState } from "react";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";
import { Modal, ModalHeader } from "./Modal.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ModelBundleNotice, useModelBundle } from "./ModelBundleNotice.tsx";
import { TONE_CLASS, bilingualShort, describeBilingual, isReadable, needsPairing, needsTranslation } from "../lib/bilingual-state.ts";

const chapters = (n: number) => `${n} chapter${n === 1 ? "" : "s"}`;

// Two steps make a chapter readable side by side with its translation. The dialog names them, says
// what each costs, and counts chapters — never sentences — because chapters are what was selected.
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
  const refresh = () => Promise.all([utils.bilingual.selection.invalidate(input), utils.bilingual.chapterStates.invalidate(), utils.bilingual.status.invalidate(), utils.bilingual.readiness.invalidate(), utils.bilingual.exportStatus.invalidate()]);
  const prepare = trpc.bilingual.prepareSelection.useMutation({ onSuccess: refresh });
  const cancel = trpc.bilingual.cancelSelection.useMutation({ onSuccess: refresh });
  const rows = selection.data ?? [];
  const active = rows.filter((row) => row.status?.busy).length;
  const toPair = rows.filter((row) => needsPairing(row.state.step)).length;
  const readable = rows.filter((row) => isReadable(row.state.step)).length;
  const blocked = rows.filter((row) => needsTranslation(row.state.step)).length;
  const eligible = rows.flatMap((row) => row.status?.current && !row.status.busy && !row.status.linkError && row.status.batches > 0 ? [row.status] : []);
  const batches = eligible.reduce((sum, status) => sum + status.batches, 0);
  const inputTokens = eligible.reduce((sum, status) => sum + status.estimatedInputTokens, 0);
  const submitting = prepare.isPending || cancel.isPending;
  const error = selection.error?.message ?? prepare.error?.message ?? cancel.error?.message;
  const failures = new Map(prepare.data?.filter((result) => result.error).map((result) => [result.chapterId, result.error]));

  return <Modal size="md" onClose={onClose} testId="bilingual-selection">
    <ModalHeader title="Bilingual reading" subtitle={`${chapters(chapterIds.length)} selected · with ${translationKey}`} onClose={onClose} />
    <div className="flex min-h-0 flex-col gap-4 p-4">
      <div className="shrink-0 space-y-4">
        {!selection.isPending && (
          <p className="text-sm text-(--text-secondary)" role="status">
            {readable} of {chapters(rows.length)} ready to read side by side
            {toPair > 0 && ` · ${toPair} need sentence pairing`}
            {blocked > 0 && ` · ${blocked} need a ${translationKey} translation first`}
          </p>
        )}
        <ModelBundleNotice id="search" verb="Pairing sentences" />

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-(--text-primary)">1. Pair sentences</h3>
          <p className="text-xs text-(--text-muted)">
            Matches each sentence to its {translationKey} translation, so the reader can show them side by side and
            switch between the narrations. Runs on this computer and costs nothing.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!ready || toPair === 0 || submitting}
              title={!ready ? "Install the local search model to pair sentences" : toPair === 0 ? "Every selected chapter that can be paired already is" : "Pair the chapters that are not paired, or whose text changed since; current pairs are kept"}
              onClick={() => prepare.mutate({ ...input, stage: "pairs" })}
            >
              {toPair > 0 ? `Pair ${chapters(toPair)}` : "Nothing to pair"}
            </Button>
            {active > 0 && <Button size="sm" disabled={submitting} onClick={() => cancel.mutate(input)}>Stop ({chapters(active)} running)</Button>}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-(--text-primary)">2. Link words <span className="font-normal text-(--text-muted)">— optional</span></h3>
          <p className="text-xs text-(--text-muted)">
            Asks an AI model which words mean the same in both languages, so pointing at a word shows its partner.
            Needs paired sentences; a cloud model charges for it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ModelPicker value={model} onChange={setModel} testId="bilingual-selection-model" />
            <Button
              size="sm"
              disabled={!model || eligible.length === 0 || submitting}
              title={!model ? "Choose a model first" : eligible.length === 0 ? "No paired chapter has words left to link" : "Link only the words still missing in paired chapters"}
              onClick={() => prepare.mutate({ ...input, stage: "links", model })}
            >
              {eligible.length > 0 ? `Link words in ${chapters(eligible.length)}` : "Nothing to link"}
            </Button>
          </div>
          <p className="text-xs text-(--text-muted)">
            {eligible.length > 0
              ? `${batches} request${batches === 1 ? "" : "s"} · about ${inputTokens.toLocaleString()} input tokens, up to ${(batches * 8192).toLocaleString()} output. A failed request runs again only when asked.`
              : readable > 0 ? "Every paired chapter has its words linked." : "Pair sentences first."}
          </p>
        </section>

        {error && <p role="alert" className="text-sm text-(--danger-text)">{error}</p>}
        {selection.isPending && <p role="status" className="text-sm">Checking the selected chapters…</p>}
      </div>
      <ul className="min-h-0 overflow-y-auto divide-y divide-(--border) text-sm border-t border-(--border)">
        {rows.map((row) => {
          const { label, tone } = bilingualShort(row.state);
          const failed = failures.get(row.chapterId);
          const stopped = [row.status?.pairJob, row.status?.linkJob].some((job) => job?.status === "cancelled") && !row.status?.busy;
          return <li key={row.chapterId} className="py-2 space-y-1" data-testid="bilingual-selection-chapter">
            <div className="flex items-start justify-between gap-3">
              <span>{row.index + 1}. {row.title}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`text-xs ${TONE_CLASS[tone]}`}>{label}</span>
                <Button size="sm" variant="ghost" disabled={!isReadable(row.state.step)} title={isReadable(row.state.step) ? "Open in the bilingual reader" : "Pair this chapter first"} to={`/books/${bookId}/read?${new URLSearchParams({ chapter: String(row.index), with: translationKey })}`}>Read</Button>
              </span>
            </div>
            <p className="text-xs text-(--text-muted)">{describeBilingual(row.state, translationKey)}{stopped ? " · stopped" : ""}</p>
            {failed && <p role="alert" className="text-xs text-(--danger-text)">{failed}</p>}
          </li>;
        })}
      </ul>
      <p className="shrink-0 text-xs text-(--text-muted)">
        Work continues when this is closed. To make the book, choose Bilingual EPUB under Export.
      </p>
    </div>
  </Modal>;
}
