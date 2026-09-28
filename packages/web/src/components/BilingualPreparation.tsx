import { useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ModelBundleNotice, useModelBundle } from "./ModelBundleNotice.tsx";

export function BilingualPreparation({ bookId, chapterId, chapterIndex, translationKey, position, onOpen }: {
  bookId: string; chapterId: string; chapterIndex: number; translationKey: string; position: () => number; onOpen: () => void;
}) {
  const utils = trpc.useUtils(), navigate = useNavigate();
  const [model, setModel] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { ready } = useModelBundle("search");
  const input = { chapterId, key: translationKey };
  const status = trpc.bilingual.status.useQuery(input, { refetchInterval: (q) => q.state.data?.busy ? 2000 : false });
  const refresh = () => void utils.bilingual.status.invalidate(input);
  const prepare = trpc.bilingual.prepare.useMutation({ onSuccess: refresh });
  const cancel = trpc.bilingual.cancel.useMutation({ onSuccess: refresh });
  const data = status.data;
  const runningStage = data?.pairJob?.status === "queued" || data?.pairJob?.status === "running" ? "pairs" : "links";
  const job = data?.busy ? (runningStage === "pairs" ? data.pairJob : data.linkJob) : null;
  const error = openError ?? prepare.error?.message ?? cancel.error?.message ?? status.error?.message ?? data?.linkError ?? data?.linkJob?.error ?? data?.pairJob?.error;

  async function open() {
    if (!data?.variantId) return;
    setOpening(true); setOpenError(null);
    try {
      const landing = await utils.bilingual.position.fetch({ variantId: data.variantId, ms: position() });
      const search = new URLSearchParams({ chapter: String(chapterIndex), with: translationKey, t: String(landing.ms) });
      onOpen();
      await navigate(`/books/${bookId}/read?${search}`);
    } catch (error) { setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  }

  return (
    <details className="shrink-0 border-t border-(--border) px-4 py-2 text-sm" data-testid="bilingual-preparation">
      <summary className="cursor-pointer text-(--text-secondary)">
        Bilingual reading{data?.current ? ` · ${data.pairs} sentence groups · ${data.linked}/${data.matched} groups with word links` : " · prepare this translation"}
        {job ? ` · ${job.status} ${job.done}/${job.total}` : error ? " · needs attention" : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <ModelBundleNotice id="search" verb="Pairing sentences" />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={!data?.variantId || !ready || data.busy || prepare.isPending}
            title="Pair the existing texts locally. Re-pairing replaces the saved pairs and their word links."
            onClick={() => data?.variantId && prepare.mutate({ variantId: data.variantId, stage: "pairs" })}>
            {data?.current ? "Re-pair sentences" : "Pair sentences"}
          </Button>
          <Button size="sm" variant="primary" disabled={!data?.current || opening} title="Open at the matched sentence when both narrations have timing; otherwise start at the beginning." onClick={() => void open()}>
            {opening ? "Opening…" : "Open bilingual reader"}
          </Button>
          {job && data?.variantId ? <Button size="sm" variant="secondary" disabled={cancel.isPending}
            title="Keep completed work. The current batch may finish, but its result will be discarded."
            onClick={() => data.variantId && cancel.mutate({ variantId: data.variantId, stage: runningStage })}>Stop</Button> : null}
        </div>
        {data?.current ? <>
          <div className="flex flex-wrap items-center gap-2">
            <ModelPicker value={model} onChange={setModel} testId="bilingual-link-model" />
            <Button size="sm" variant="secondary" disabled={!model || !data.variantId || data.busy || prepare.isPending || data.batches === 0 || !!data.linkError}
              onClick={() => data.variantId && prepare.mutate({ variantId: data.variantId, stage: "links", model })}>
              {data.linked ? "Link remaining words" : "Link words"}
            </Button>
          </div>
          <p className="text-xs text-(--text-muted)">
            {data.batches} remaining batches · roughly {data.estimatedInputTokens.toLocaleString()} input tokens, up to 8,192 output tokens per batch.
            Uses the selected model; cloud providers may charge. Failed work is retried only when requested.
          </p>
        </> : <p className="text-xs text-(--text-muted)">Pair existing chapter and translation text first. Narration is optional; preparing text does not generate audio.</p>}
        {error ? <p role="alert" className="text-xs text-(--danger-text)">{error}</p> : null}
      </div>
    </details>
  );
}
