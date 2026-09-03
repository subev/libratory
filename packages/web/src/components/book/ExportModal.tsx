import { Modal, ModalHeader } from "../Modal.tsx";
import { Button } from "../Button.tsx";

export type ExportFormatId = "epub-sync" | "m4b" | "epub" | "pdf";

export type ExportFormat = {
  id: ExportFormatId;
  label: string;
  subtitle: string;
  /** How many of the selection this format can actually take — four different numbers over one selection. */
  count: number;
  disabled: boolean;
  reason?: string;
  recommended?: boolean;
  extra?: React.ReactNode;
};

// One modal, one CTA, one disabled state. Six controls used to sit below the chapter table: two
// create-tabs, assemble, three exports and a timing choice — at the far end of the page from the
// selection they consume. It also closes a documented bug: a second export while one renders throws
// "Assembly already in progress", and the old UI only disabled the format you had clicked.
export function ExportModal({
  formats,
  value,
  onChange,
  scopeSummary,
  timing,
  dropDir,
  busy,
  onConfirm,
  onClose,
}: {
  formats: ExportFormat[];
  value: ExportFormatId;
  onChange: (id: ExportFormatId) => void;
  scopeSummary: string;
  timing: {
    inFlight: number;
    verb: "synthesizing" | "translating";
    readyCount: number;
    totalCount: number;
    waitForAll: boolean;
    onChange: (waitForAll: boolean) => void;
  };
  dropDir: { path: string; checked: boolean; onChange: (next: boolean) => void } | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const active = formats.find((f) => f.id === value);
  const label = "text-[10px] font-bold uppercase tracking-wider text-(--text-faint)";

  return (
    <Modal size="sm" onClose={onClose} testId="export-modal">
      <ModalHeader title="Export" onClose={onClose} />
      <div className="p-4 overflow-y-auto space-y-4">
        <div>
          <span className={`block mb-1.5 ${label}`}>From</span>
          {/* Read-only. There is one selection in this app — the chapter checkboxes every other
              action reads — and a second scope only Export understood could disagree with the
              table behind it. The count is per format because they are four different numbers. */}
          <p className="text-xs text-(--text-secondary) rounded-lg border border-(--border) bg-(--bg-subtle) px-3 py-2" data-testid="export-scope">
            {scopeSummary}
          </p>
        </div>

        <div>
          <span className={`block mb-1.5 ${label}`}>Format</span>
          <div className="space-y-1.5" role="radiogroup" aria-label="Export format">
            {formats.map((format) => {
              const selected = format.id === value;
              return (
                <div key={format.id}>
                  {/* button-ok: a radio card — the ring and the fill belong to the group, not to an action */}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onChange(format.id)}
                    disabled={format.disabled}
                    title={format.reason}
                    data-testid={`export-format-${format.id}`}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left disabled:opacity-50 disabled:cursor-not-allowed ${
                      selected ? "border-(--accent) bg-(--accent-subtle)" : "border-(--border) enabled:hover:bg-(--bg-card-hover)"
                    }`}
                  >
                    <span
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                        selected ? "border-(--accent) bg-(--accent)" : "border-(--border-input)"
                      }`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-(--text-primary)">{format.label}</span>
                        {format.recommended && (
                          <span className="px-1.5 rounded-full text-[9.5px] font-bold tracking-wide bg-(--accent) text-(--on-accent)">
                            RECOMMENDED
                          </span>
                        )}
                        <span className="text-xs text-(--text-faint) tabular-nums">{format.count}</span>
                      </span>
                      <span className="block mt-0.5 text-xs text-(--text-muted)">{format.disabled && format.reason ? format.reason : format.subtitle}</span>
                    </span>
                  </button>
                  {/* Not gated on selection: the only thing hanging off a card is the renderer
                      download, and a missing renderer is exactly what disables that card. */}
                  {format.extra}
                </div>
              );
            })}
          </div>
        </div>

        {/* Above the format group on purpose: deferring is not a preference, it decides whether the
            two audio formats can be picked at all. */}
        {timing && timing.inFlight > 0 && (
          <div className="rounded-lg border border-(--border) bg-(--badge-synthesizing-bg) p-3" data-testid="output-timing">
            <p className="text-xs font-bold text-(--badge-synthesizing-text) mb-2">
              {timing.inFlight} of {timing.totalCount} selected chapters are still {timing.verb}
            </p>
            <label className="flex items-center gap-2 text-xs text-(--text-primary) cursor-pointer">
              <input type="radio" checked={!timing.waitForAll} onChange={() => timing.onChange(false)} data-testid="output-timing-now" />
              Export the {timing.readyCount} that are ready now
            </label>
            <label className="flex items-center gap-2 mt-1.5 text-xs text-(--text-primary) cursor-pointer">
              <input type="radio" checked={timing.waitForAll} onChange={() => timing.onChange(true)} data-testid="output-timing-wait" />
              Queue it — it runs by itself once all {timing.totalCount} finish
            </label>
          </div>
        )}

        {dropDir && value === "epub-sync" && (
          <label
            className="flex items-center gap-2 text-xs text-(--text-muted) cursor-pointer hover:text-(--text-secondary)"
            title={`Copies the synced EPUB to ${dropDir.path} so Storyteller picks it up automatically (READALOUD_DROP_DIR in .env)`}
          >
            <input type="checkbox" checked={dropDir.checked} onChange={(e) => dropDir.onChange(e.target.checked)} className="rounded" data-testid="copy-to-import" />
            Copy to Storyteller import folder
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-(--border) bg-(--bg-subtle)">
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={!active || active.disabled || busy}
          title={active?.disabled ? active.reason : undefined}
          data-testid="export-confirm"
        >
          Export {active?.label ?? ""}
        </Button>
      </div>
    </Modal>
  );
}
