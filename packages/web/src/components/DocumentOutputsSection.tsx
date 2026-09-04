import { filesSummary, formatOutputDate, formatSize, formatTag, pendingExportSummary, type DocumentFormat } from "../lib/format.ts";
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
    description: "No audio — small, and opens anywhere: EPUB in Apple Books, Kobo, Kindle or Calibre, PDF in anything.",
  },
} as const;

// A Record rather than a predicate: a format added later fails to compile until it is filed
const GROUP_OF: Record<DocumentFormat, keyof typeof GROUPS> = {
  "epub-sync": "synced",
  epub: "text",
  pdf: "text",
};

export function DocumentOutputsSection({
  kind,
  read,
  documents,
  pending,
  onDelete,
  isDeleting,
}: {
  kind: keyof typeof GROUPS;
  // Only the read-along group offers it: the reader shows the same book this file carries
  read?: { bookId: string; can: boolean; title: string };
  documents: DocumentRow[];
  pending: PendingExport[];
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  const mine = documents.filter((doc) => GROUP_OF[doc.format] === kind);
  const minePending = pending.filter((p) => GROUP_OF[p.format] === kind);
  return (
    <ResourceGroup
      title={GROUPS[kind].title}
      description={GROUPS[kind].description}
      count={
        minePending.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-(--accent-text)" data-testid={`export-pending-${kind}`}>
            <ActivityDot className="text-(--accent)" />
            {minePending.map(pendingExportSummary).join(" · ")}...
          </span>
        ) : mine.length === 0 ? (
          "nothing exported yet"
        ) : (
          filesSummary(mine)
        )
      }
    >
      {mine.map((doc) => {
        const filename = doc.outputPath.split("/").pop();
        const readAlong = doc.format === "epub-sync";
        return (
          <ResourceRow
            key={doc.id}
            testId="document-row"
            tone={readAlong ? "accent" : "muted"}
            icon={readAlong ? <IconBook className="h-3.5 w-3.5" /> : <IconDocument className="h-3.5 w-3.5" />}
            title={filename}
            tag={<FormatTag>{formatTag(filename)}</FormatTag>}
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
                {readAlong && read && (
                  <Button
                    variant="icon"
                    size="sm"
                    to={`/books/${read.bookId}/read`}
                    disabled={!read.can}
                    title={read.title}
                    aria-label="Read"
                    data-testid="document-read"
                  >
                    <IconBook className="h-4 w-4" />
                  </Button>
                )}
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
