import { formatOutputDate, formatDuration } from "../lib/format.ts";

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
}: {
  assemblies: AssemblyRow[];
  latestOutputPath: string | null;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}) {
  if (assemblies.length === 0) return null;

  return (
    <section className="rounded-xl border border-(--border) border-t-2 border-t-(--step-output)/80 bg-(--bg-card) p-4 flex flex-col">
      <h2 className="text-lg font-semibold text-(--text-secondary) mb-3">
        <span className="text-xs font-medium text-(--success-text) uppercase tracking-wider mr-2">3 · Output</span>
        Assemblies
      </h2>
      {(
        <ul className="divide-y divide-(--divide) rounded-lg border border-(--border)">
          {assemblies.map((assembly) => {
            const isLatest = assembly.outputPath === latestOutputPath;
            return (
              <li key={assembly.id} className="px-3 py-2.5 hover:bg-(--bg-card-hover)" data-testid="assembly-row">
                <div className="flex items-center gap-2 text-sm text-(--text-secondary)">
                  {formatOutputDate(assembly.createdAt)}
                  {isLatest && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-(--success-bg) text-(--success-text)">
                      latest
                    </span>
                  )}
                  <span className="text-(--text-tertiary)" title={assembly.chapterSummary}>
                    {assembly.chapterCount} chapter{assembly.chapterCount !== 1 ? "s" : ""}
                  </span>
                  <span className="ml-auto tabular-nums text-(--text-tertiary)">{formatDuration(assembly.durationMs)}</span>
                </div>
                <div className="flex items-center gap-3 mt-1.5">
                  <audio controls preload="none" className="h-8 min-w-0 flex-1">
                    <source src={`/audio/assembly/${assembly.id}`} type="audio/mpeg" />
                  </audio>
                  <a
                    href={`/download/assembly/${assembly.id}`}
                    download={assembly.outputPath.split("/").pop()}
                    className="text-xs text-(--success-text) hover:text-(--success-text-hover) font-medium shrink-0"
                    data-testid="assembly-download"
                  >
                    Download
                  </a>
                  <button
                    onClick={() => {
                      if (confirm("Delete this assembly?")) {
                        onDelete(assembly.id);
                      }
                    }}
                    disabled={isDeleting}
                    className="text-xs text-(--danger-text) hover:text-(--danger-text-hover) font-medium disabled:opacity-50 shrink-0"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
