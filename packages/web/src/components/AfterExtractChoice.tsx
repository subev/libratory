// Shared by the book page's Extract modal and the home-page dropzone: the same decision, at the
// same moment, with the same consequence — so it reads identically in both.
export function AfterExtractChoice({
  autoSynthesize,
  onChange,
  voiceLabel,
  chapterCount,
}: {
  autoSynthesize: boolean;
  onChange: (autoSynthesize: boolean) => void;
  voiceLabel: string;
  chapterCount?: number;
}) {
  const scale = chapterCount ? ` — ${chapterCount} chapter${chapterCount === 1 ? "" : "s"}` : "";

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-(--text-secondary) mb-1">When extraction finishes</legend>

      <label className={`flex gap-2 rounded-md border p-2 cursor-pointer ${autoSynthesize ? "border-(--accent) bg-(--bg-selected)" : "border-(--border) hover:bg-(--bg-subtle)"}`}>
        <input
          type="checkbox"
          checked={autoSynthesize}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 rounded"
          data-testid="auto-synthesize"
        />
        <span className="min-w-0">
          <span className="block text-sm text-(--text-primary)">Start synthesizing straight away</span>
          <span className="block text-xs text-(--text-muted)">
            Narrates with <strong>{voiceLabel}</strong>{scale}. This runs on your CPU/GPU and can take a while —
            leave it off if you want to read the text or pick a different voice first.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
