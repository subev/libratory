import { filesSummary, formatOutputDate, formatSize, pendingExportSummary, type DocumentFormat } from "../lib/format.ts";
import { Button } from "./Button.tsx";
import { IconBook, IconDelete, IconDocument, IconDownload } from "./icons.tsx";
import { FormatTag, ResourceGroup, ResourceRow } from "./book/ResourceRow.tsx";
import { ActivityDot } from "./book/StageTabs.tsx";

export type DocumentRow = {
  id: string;
  format: DocumentFormat;
  outputPath: string;
  chapterCount: number;
  chapterSummary: string;
  sizeBytes: number | null;
  createdAt: string | Date;
};

export type PendingExport = {
  format: DocumentFormat;
  language: string | null;
  running: boolean;
  waiting: boolean;
  copyToDropDir: boolean;
};

// Split by what the file is for rather than by extension: a synced EPUB and a plain one share a
// format and almost nothing else, and the read-along belongs beside the audio it carries.
const GROUPS = {
  synced: {
    title: "Audio + text",
    description: "Both formats in one file — the narration and the text locked together, so the words highlight as they are read.",
  },
  text: {
    title: "Text only",
    description: "No audio — small, and opens in any EPUB reader: Apple Books, Kobo, Kindle, Calibre.",
  },
} as const;

export function DocumentOutputsSection({
  kind,
  documents,
  pending,
  onDelete,
  isDeleting,
}: {
  kind: keyof typeof GROUPS;
  documents: DocumentRow[];
  pending: PendingExport[];
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  const belongs = (format: DocumentFormat) => (format === "epub-sync") === (kind === "synced");
  return (
    <DocumentGroup
      {...GROUPS[kind]}
      documents={documents.filter((doc) => belongs(doc.format))}
      pending={pending.filter((p) => belongs(p.format))}
      onDelete={onDelete}
      isDeleting={isDeleting}
    />
  );
}

function DocumentGroup({
  title,
  description,
  documents,
  pending,
  onDelete,
  isDeleting,
}: {
  title: string;
  description: string;
  documents: DocumentRow[];
  pending: PendingExport[];
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  return (
    <ResourceGroup
      title={title}
      description={description}
      count={
        pending.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-(--accent-text)" data-testid="export-pending">
            <ActivityDot className="text-(--accent)" />
            {pending.map(pendingExportSummary).join(" · ")}...
          </span>
        ) : documents.length === 0 ? (
          "nothing exported yet"
        ) : (
          filesSummary(documents)
        )
      }
    >
      {documents.map((doc) => {
        const filename = doc.outputPath.split("/").pop();
        const readAlong = doc.format === "epub-sync";
        return (
          <ResourceRow
            key={doc.id}
            testId="document-row"
            tone={readAlong ? "accent" : "muted"}
            icon={readAlong ? <IconBook className="h-3.5 w-3.5" /> : <IconDocument className="h-3.5 w-3.5" />}
            title={filename}
            tag={<FormatTag>{doc.format === "pdf" ? "PDF" : "EPUB"}</FormatTag>}
            subtitle={
              <>
                <span title={doc.chapterSummary}>
                  {doc.chapterCount} chapter{doc.chapterCount === 1 ? "" : "s"}
                </span>{" "}
                · {formatOutputDate(doc.createdAt)}
              </>
            }
            size={formatSize(doc.sizeBytes)}
            actions={
              <>
                <Button
                  variant="icon"
                  size="sm"
                  href={`/download/document/${doc.id}`}
                  download={filename}
                  aria-label={`Download ${filename}`}
                  title="Download"
                  data-testid="document-download"
                >
                  <IconDownload className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger"
                  soft
                  square
                  size="sm"
                  onClick={() => {
                    if (confirm("Delete this document?")) onDelete(doc.id);
                  }}
                  disabled={isDeleting}
                  aria-label={`Delete ${filename}`}
                  title="Delete"
                >
                  <IconDelete className="h-4 w-4" />
                </Button>
              </>
            }
          />
        );
      })}
    </ResourceGroup>
  );
}
