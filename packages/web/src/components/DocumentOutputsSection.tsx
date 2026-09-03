import { formatOutputDate, documentFormatLabel, pendingExportSummary, type DocumentFormat } from "../lib/format.ts";
import { Button } from "./Button.tsx";
import { IconBook, IconDelete, IconDocument, IconDownload } from "./icons.tsx";
import { ResourceGroup, ResourceRow } from "./book/ResourceRow.tsx";
import { ActivityDot } from "./book/StageTabs.tsx";

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
  return (
    <ResourceGroup
      title="Documents"
      count={
        pending.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-(--accent-text)" data-testid="export-pending">
            <ActivityDot className="text-(--accent)" />
            {pending.map(pendingExportSummary).join(" · ")}...
          </span>
        ) : documents.length === 0 ? (
          "nothing exported yet"
        ) : (
          `${documents.length} file${documents.length === 1 ? "" : "s"}`
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
            subtitle={
              <>
                {documentFormatLabel(doc.format)} ·{" "}
                <span title={doc.chapterSummary}>
                  {doc.chapterCount} chapter{doc.chapterCount === 1 ? "" : "s"}
                </span>{" "}
                · {formatOutputDate(doc.createdAt)}
              </>
            }
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
