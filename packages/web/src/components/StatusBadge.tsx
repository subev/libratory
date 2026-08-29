type StatusBadgeProps = {
  status: string;
  error?: string | null;
  chaptersCompleted?: number;
  totalChapters?: number;
};

export const statusStyles = {
  pending: "bg-(--badge-pending-bg) text-(--badge-pending-text)",
  extracting: "bg-(--badge-extracting-bg) text-(--badge-extracting-text)",
  synthesizing: "bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)",
  normalizing: "bg-(--badge-normalizing-bg) text-(--badge-normalizing-text)",
  assembling: "bg-(--badge-assembling-bg) text-(--badge-assembling-text)",
  done: "bg-(--badge-done-bg) text-(--badge-done-text)",
  failed: "bg-(--badge-failed-bg) text-(--badge-failed-text)",
  suspended: "bg-(--badge-suspended-bg) text-(--badge-suspended-text)",
  cancelled: "bg-(--badge-cancelled-bg) text-(--badge-cancelled-text)",
  untranslated: "bg-(--bg-subtle) text-(--text-faint)",
  missing: "bg-(--bg-subtle) text-(--text-faint)",
  translating: "bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)",
  rewriting: "bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)",
  cleaning: "bg-(--badge-normalizing-bg) text-(--badge-normalizing-text)",
} satisfies Record<string, string>;

export function StatusBadge({ status, error, chaptersCompleted, totalChapters }: StatusBadgeProps) {
  const isCancelled = status === "failed" && error?.startsWith("Cancelled");
  const displayStatus = isCancelled ? "cancelled" : status;
  const style = (statusStyles as Record<string, string>)[displayStatus] ?? statusStyles.pending;

  let label = displayStatus;
  if (displayStatus === "synthesizing" && totalChapters && totalChapters > 0) {
    label = `synthesizing ${chaptersCompleted ?? 0}/${totalChapters}`;
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}
