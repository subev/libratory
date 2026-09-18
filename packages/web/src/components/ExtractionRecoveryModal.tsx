import { useState } from "react";
import type { ExtractionSettings } from "../../../server/src/lib/extraction-presets.ts";
import type { BookFileRow } from "./BookFilesSection.tsx";
import { trpc } from "../trpc.ts";
import { Button } from "./Button.tsx";
import { Modal, ModalHeader } from "./Modal.tsx";

type Routing = NonNullable<ExtractionSettings["pageRouting"]>;
const choices: { value: Routing; label: string }[] = [
  { value: "auto", label: "Automatic — use local layout evidence" },
  { value: "prose", label: "Prose — skip the ordering stage" },
  { value: "preset", label: "Book preset — keep its ordering instructions" },
];

export function ExtractionRecoveryModal({ bookId, files, settings, isProcessing, onClose }: {
  bookId: string; files: BookFileRow[]; settings?: ExtractionSettings | null; isProcessing: boolean; onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState(() => new Set(files.filter((file) => file.status === "failed" || file.status === "suspended").map((file) => file.id)));
  const [routes, setRoutes] = useState<Record<string, Routing>>(() => Object.fromEntries(files.map((file) => [file.id, settings?.fileRouting?.[file.id] ?? "auto"])));
  const [reviewId, setReviewId] = useState(files.find((file) => file.extractionProgress?.reviewPages.length)?.id ?? files[0]?.id ?? "");
  const [repairLimit, setRepairLimit] = useState(10);
  const [page, setPage] = useState<number | null>(null);
  const review = trpc.bookFiles.extractionReview.useQuery({ id: reviewId }, { enabled: !!reviewId, refetchInterval: isProcessing ? 5000 : false });
  const resume = trpc.bookFiles.resumeExtraction.useMutation({ onSuccess: async () => { await utils.books.get.invalidate({ id: bookId }); onClose(); } });
  const chosen = files.filter((file) => selected.has(file.id) && (file.status === "failed" || file.status === "suspended"));
  const saved = chosen.reduce((sum, file) => sum + (file.extractionProgress?.saved ?? 0), 0);
  const unknown = chosen.some((file) => file.extractionProgress?.total == null);
  const remaining = chosen.reduce((sum, file) => sum + Math.max(0, (file.extractionProgress?.total ?? 0) - (file.extractionProgress?.saved ?? 0)), 0);
  const maxCalls = chosen.reduce((sum, file) => sum + Math.max(0, (file.extractionProgress?.total ?? 0) - (file.extractionProgress?.saved ?? 0))
    * (routes[file.id] === "prose" || !settings?.lineOrdering ? 1 : 2), 0);
  const diagnostic = review.data?.diagnostics.find((entry) => entry.page === page) ?? review.data?.diagnostics[0];
  const blocked = isProcessing ? "Wait for the running extraction to finish" : chosen.some((file) => file.extractionProgress?.problem)
    ? "Resolve the unreadable checkpoint first" : !chosen.length ? "Select failed or stopped files" : null;

  return <Modal size="full" onClose={onClose}>
    <ModalHeader title="Saved extraction and recovery" onClose={onClose} />
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <p className="text-sm text-(--text-secondary)">The system revalidates saved responses locally, then uses AI to repair failed stages within your chosen limit. You do not need to correct pages manually. Saved pages are kept. Layout choices apply only to unresolved pages. Recovery preserves existing chapters, edits and audio; a file that already has chapters cannot be replaced here.</p>
      {files.map((file) => {
        const progress = file.extractionProgress;
        const eligible = file.status === "failed" || file.status === "suspended";
        return <div key={file.id} className="flex flex-wrap items-center gap-3 border-b border-(--border) pb-2">
          <label className="flex items-center gap-2 text-sm text-(--text-primary)">
            <input type="checkbox" checked={selected.has(file.id)} disabled={!eligible || resume.isPending}
              onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} />
            {file.filename}
          </label>
          <span className="text-xs text-(--text-muted)">{progress?.problem ?? (progress ? `${progress.saved}/${progress.total ?? "?"} pages saved · ${progress.reviewPages.length} await recovery` : "No saved AI page count yet")}</span>
          <select aria-label={`Layout for ${file.filename}`} value={routes[file.id] ?? "auto"} disabled={!eligible || resume.isPending}
            className="rounded border border-(--border) bg-(--bg-input) px-2 py-1 text-sm"
            onChange={(event) => { const choice = choices.find((entry) => entry.value === event.target.value); if (choice) setRoutes((previous) => ({ ...previous, [file.id]: choice.value })); }}>
            {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          <Button size="sm" onClick={() => { setReviewId(file.id); setPage(null); }}>Inspect pages</Button>
        </div>;
      })}
      <p className="text-sm text-(--text-secondary)">
        {saved} saved pages will be reused. {unknown ? "Some page counts are not available yet; a total call estimate is unavailable." : `${remaining} pages remain; at most ${maxCalls + repairLimit} new page-reading calls including the repair budget in this attempt, fewer when an ordering checkpoint can be reused.`}
        {" "}The repair limit counts additional calls, not dollars. Provider token charges vary; rejected attempts may also be billed. At most one corrective call per failed stage, within the shared run budget. Connection failures stop without automatic retries. Chapter detection may make additional calls if enabled for the book.
      </p>
      <p className="text-xs text-(--text-muted)">Automatic uses local line detection, without a paid classifier. Clear flowing prose skips ordering; ambiguous layouts keep the book preset. Prose reads the image directly and preserves paragraphs and footnotes without song-specific instructions.</p>
      <label className="flex items-center gap-2 text-sm text-(--text-secondary)">Extra AI calls allowed for automatic repair
        <select value={repairLimit} disabled={resume.isPending} onChange={(event) => setRepairLimit(Number(event.target.value))}
          className="rounded border border-(--border) bg-(--bg-input) px-2 py-1">
          {[0, 5, 10, 20, 50].map((limit) => <option key={limit} value={limit}>{limit === 0 ? "None — no extra repair calls" : `${limit} across all selected files`}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!!blocked || resume.isPending} title={blocked ?? undefined}
          onClick={() => resume.mutate({ bookId, repairLimit, files: chosen.map((file) => ({ id: file.id, routing: routes[file.id] ?? "auto" })) })}>
          {resume.isPending ? "Queuing recovery…" : "Repair and resume"}
        </Button>
        {blocked && <span className="text-sm text-(--text-muted)">{blocked}</span>}
      </div>
      {resume.error && <p role="alert" className="text-sm text-(--danger-text)">{resume.error.message}</p>}
      {review.error && <p role="alert" className="text-sm text-(--danger-text)">{review.error.message}</p>}
      {review.isLoading && <p className="text-sm text-(--text-muted)">Reading saved page diagnostics…</p>}
      {review.data && !diagnostic && <p className="text-sm text-(--text-muted)">No unresolved page diagnostics for this file. Saved pages remain available for recovery.</p>}
      {diagnostic && <details>
        <summary className="cursor-pointer text-sm text-(--text-secondary)">Optional: inspect saved evidence</summary>
        <div className="flex flex-wrap gap-2">
          {review.data?.diagnostics.map((entry) => <Button key={entry.page} size="sm" variant={entry.page === diagnostic.page ? "primary" : "secondary"}
            onClick={() => setPage(entry.page)}>PDF page {entry.page}</Button>)}
        </div>
        <p className="text-sm text-(--warning-text)">{diagnostic.response ? "The saved response is awaiting automated recovery." : "Processing stopped before a usable response was saved."} {diagnostic.message}</p>
        <iframe key={`${reviewId}-${diagnostic.page}`} src={`/pdf/${reviewId}#page=${diagnostic.page}`} title={`Source PDF page ${diagnostic.page}`} className="h-[32rem] w-full border border-(--border)" />
        <details className="text-sm text-(--text-secondary)">
          <summary className="cursor-pointer">Saved response and detected lines</summary>
          <pre className="overflow-x-auto whitespace-pre-wrap p-3 text-xs">{diagnostic.response ?? "No response saved"}</pre>
          <ol className="space-y-1">{diagnostic.lines?.map((line) => <li key={line.id}><span className="font-mono">{line.id}</span>: {line.text}</li>)}</ol>
        </details>
      </details>}
    </div>
  </Modal>;
}
