import { formatOutputDate, documentFormatLabel, pendingExportSummary, type DocumentFormat } from "../lib/format.ts";

export type DocumentRow = {
  id: string;
  format: DocumentFormat;
  outputPath: string;
  chapterCount: number;
  chapterSummary: string;
  createdAt: string | Date;
};

export type PendingExport = {
  format: DocumentFormat;
  language: string | null;
  running: boolean;
  waiting: boolean;
  copyToDropDir: boolean;
};

export function DocumentOutputsSection({
  documents,
  pending,
  onDelete,
  isDeleting,
}: {
  documents: DocumentRow[];
  pending: PendingExport[];
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  if (documents.length === 0 && pending.length === 0) return null;

  return (
    <section className="rounded-xl border border-(--border) border-t-2 border-t-(--step-output)/80 bg-(--bg-card) p-4 flex flex-col">
      <h2 className="text-lg font-semibold text-(--text-secondary) mb-3">
        <span className="text-xs font-medium text-(--step-output) uppercase tracking-wider mr-2">3 · Output</span>
        Documents
        {pending.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-(--step-output) ml-3" data-testid="export-pending">
            <span className="w-2 h-2 rounded-full bg-(--step-output) animate-pulse" />
            {pending.map(pendingExportSummary).join(" · ")}...
          </span>
        )}
      </h2>
      {documents.length === 0 ? (
        <p className="text-sm text-(--text-muted)">Rendering...</p>
      ) : (
        <ul className="divide-y divide-(--divide) rounded-lg border border-(--border)">
          {documents.map((doc) => (
            <li key={doc.id} className="px-3 py-2.5 flex items-center gap-2 hover:bg-(--bg-card-hover)" data-testid="document-row">
              <span className="text-sm text-(--text-secondary)">{formatOutputDate(doc.createdAt)}</span>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--success-bg) text-(--success-text) uppercase">
                {documentFormatLabel(doc.format)}
              </span>
              <span className="text-sm text-(--text-tertiary)" title={doc.chapterSummary}>
                {doc.chapterCount} chapter{doc.chapterCount !== 1 ? "s" : ""}
              </span>
              <div className="ml-auto flex items-center gap-3 shrink-0">
                <a
                  href={`/download/document/${doc.id}`}
                  download={doc.outputPath.split("/").pop()}
                  className="text-xs text-(--success-text) hover:text-(--success-hover) font-medium"
                  data-testid="document-download"
                >
                  Download
                </a>
                <button
                  onClick={() => {
                    if (confirm("Delete this document?")) {
                      onDelete(doc.id);
                    }
                  }}
                  disabled={isDeleting}
                  className="text-xs text-(--danger-text) hover:text-(--danger-hover) font-medium disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
