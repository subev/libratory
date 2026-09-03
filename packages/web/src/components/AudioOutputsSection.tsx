import type { ReactNode } from "react";
import { formatOutputDate, formatDuration } from "../lib/format.ts";
import { Button } from "./Button.tsx";
import { IconDelete, IconDownload, IconPlay } from "./icons.tsx";
import { ResourceGroup, ResourceRow } from "./book/ResourceRow.tsx";

export type AssemblyRow = {
  id: string;
  outputPath: string;
  durationMs: number;
  chapterCount: number;
  chapterSummary: string;
  createdAt: string | Date;
};

export function AudioOutputsSection({
  assemblies,
  latestOutputPath,
  onDelete,
  isDeleting,
  action,
}: {
  assemblies: AssemblyRow[];
  latestOutputPath: string | null;
  onDelete: (id: string) => void;
  isDeleting: boolean;
  action?: ReactNode;
}) {
  return (
    <ResourceGroup
      title="Audio"
      count={assemblies.length === 0 ? "nothing assembled yet" : `${assemblies.length} file${assemblies.length === 1 ? "" : "s"}`}
      action={action}
    >
      {assemblies.map((assembly) => {
        const isLatest = assembly.outputPath === latestOutputPath;
        const filename = assembly.outputPath.split("/").pop();
        return (
          <ResourceRow
            key={assembly.id}
            testId="assembly-row"
            tone={isLatest ? "accent" : "muted"}
            icon={<IconPlay className="h-3.5 w-3.5" />}
            title={filename}
            subtitle={
              <>
                {formatDuration(assembly.durationMs)} ·{" "}
                <span title={assembly.chapterSummary}>
                  {assembly.chapterCount} chapter mark{assembly.chapterCount === 1 ? "" : "s"}
                </span>{" "}
                · {formatOutputDate(assembly.createdAt)}
              </>
            }
            badge={
              isLatest ? (
                <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-(--success-bg) text-(--success-text)">
                  latest
                </span>
              ) : undefined
            }
            actions={
              <>
                <Button
                  variant="icon"
                  size="sm"
                  href={`/download/assembly/${assembly.id}`}
                  aria-label={`Download ${filename}`}
                  title="Download"
                  data-testid="assembly-download"
                >
                  <IconDownload className="h-4 w-4" />
                </Button>
                <Button
                  variant="danger"
                  soft
                  square
                  size="sm"
                  onClick={() => {
                    if (confirm("Delete this assembly?")) onDelete(assembly.id);
                  }}
                  disabled={isDeleting}
                  aria-label={`Delete ${filename}`}
                  title="Delete"
                >
                  <IconDelete className="h-4 w-4" />
                </Button>
              </>
            }
          >
            {/* Kept, though the artboard drops it: the leading tile there is decoration, and this is
                the only place an assembly can be listened to without downloading it first. */}
            <audio controls preload="none" className="h-8 w-full mt-1.5">
              <source src={`/audio/assembly/${assembly.id}`} type="audio/mp4" />
            </audio>
          </ResourceRow>
        );
      })}
    </ResourceGroup>
  );
}
