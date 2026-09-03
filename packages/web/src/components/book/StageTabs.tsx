import { IconLocked } from "../icons.tsx";
import { useShellLayout } from "./BookShell.tsx";

// Colour encodes the pipeline sequence here now, in the numbered chips, rather than on Section's
// top stripe — the tabs are the order the page used to spell out in stacked cards.
export type StageBadgeTone = "extracting" | "synthesizing" | "assembling";

const BADGE: Record<StageBadgeTone, string> = {
  extracting: "bg-(--badge-extracting-bg) text-(--badge-extracting-text)",
  synthesizing: "bg-(--badge-synthesizing-bg) text-(--badge-synthesizing-text)",
  assembling: "bg-(--badge-assembling-bg) text-(--badge-assembling-text)",
};

export type StageTab = {
  id: string;
  /** Numbered stages carry a chip; Notes is not a stage and carries none. */
  step?: number;
  label: string;
  count?: number | string;
  title?: string;
  locked?: boolean;
  badge?: { text: string; tone: StageBadgeTone } | null;
  trailing?: boolean;
};

function ActivityDot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full bg-current animate-[pulse-dot_1.15s_ease-in-out_infinite] ${className}`} />;
}

export function StageTabs({
  tabs,
  value,
  onChange,
  hint,
}: {
  tabs: StageTab[];
  value: string;
  onChange: (id: string) => void;
  hint?: string;
}) {
  const layout = useShellLayout();

  return (
    <div className="flex items-stretch gap-1 h-11 px-4 border-b border-(--border) bg-(--bg-card)" role="tablist">
      {tabs.map((tab) => {
        const active = value === tab.id;
        return (
          <span key={tab.id} className={tab.trailing ? "ml-auto flex items-stretch" : "flex items-stretch"}>
            {/* button-ok: a tab picks which panel shows, it does not act — the underline is the group's */}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              disabled={tab.locked}
              onClick={() => onChange(tab.id)}
              title={tab.title}
              data-testid={`stage-tab-${tab.id}`}
              className={`flex items-center gap-2 px-3 text-xs border-b-2 disabled:cursor-not-allowed ${
                active ? "border-(--accent) text-(--text-primary) font-bold" : "border-transparent font-medium"
              } ${tab.locked ? "text-(--text-faint)" : active ? "" : "text-(--text-muted) hover:text-(--text-secondary)"}`}
            >
              {tab.step !== undefined && (
                <span
                  className={`w-4 h-4 grid place-items-center rounded-full text-[9.5px] font-bold border ${
                    active ? "bg-(--accent) text-(--on-accent) border-(--accent)" : "text-(--text-faint) border-(--border-input)"
                  }`}
                >
                  {tab.step}
                </span>
              )}
              {/* The active tab keeps its label when the rest lose theirs: a row of bare
                  numerals says nothing about where you are. */}
              {(layout.showLabels || active) && tab.label}
              {tab.count !== undefined && <span className="text-(--text-faint) font-normal tabular-nums">{tab.count}</span>}
              {tab.locked && <IconLocked className="h-3 w-3" />}
              {tab.badge && (
                <span className={`flex items-center gap-1.5 px-1.5 rounded-full text-[10.5px] font-semibold ${BADGE[tab.badge.tone]}`}>
                  <ActivityDot />
                  {layout.showLabels && tab.badge.text}
                </span>
              )}
            </button>
          </span>
        );
      })}
      {hint && layout.showStageHint && (
        <span className="ml-auto flex items-center text-[11.5px] text-(--text-faint)">{hint}</span>
      )}
    </div>
  );
}
