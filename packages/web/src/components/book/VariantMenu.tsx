import { Menu, MenuDivider, MenuItem } from "../Menu.tsx";
import { IconAdd, IconCheck, IconChevronDown, IconTranslate } from "../icons.tsx";
import { variantLabel } from "../../lib/chapters.ts";
import { useShellLayout } from "./BookShell.tsx";

export type VariantLane = { key: string; kind: "translation" | "transform"; label: string | null; total: number; done: number };

// A row of pills stopped working somewhere around the third lane, and the design draws nine. It also
// renders with no lanes at all, because it now hosts the only door to VariantModal — gating it on
// lanes existing would make creating the first one impossible.
export function VariantMenu({
  lanes,
  active,
  bookLanguage,
  chapterCount,
  onSwitch,
  onAdd,
  addDisabled,
  addTitle,
}: {
  lanes: VariantLane[];
  active: string | null;
  bookLanguage: string | null;
  chapterCount: number;
  onSwitch: (key: string | null) => void;
  onAdd: () => void;
  addDisabled: boolean;
  addTitle: string;
}) {
  const layout = useShellLayout();
  const activeLane = active ? lanes.find((l) => l.key === active) ?? null : null;
  // A ?variant= deep link renders before variants.list resolves, and falling back to "Original"
  // there would contradict the banner underneath saying otherwise.
  const activeName = activeLane ? variantLabel(activeLane) : active;
  const originalName = bookLanguage ? `Original · ${bookLanguage.toUpperCase()}` : "Original";
  const currentName = activeName ?? originalName;
  const shortName = active ? (activeLane?.label ?? active).slice(0, 2).toUpperCase() : (bookLanguage ?? "EN").toUpperCase();

  return (
    <Menu
      align="right"
      width="w-74"
      testId="variant-menu"
      trigger={({ open, toggle }) => (
        // button-ok: a picker labelled with its own value, skinned to match the header's controls
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title="Switch which version of the book you are working on"
          data-testid="variant-menu-trigger"
          className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs font-semibold ${
            active
              ? "bg-(--accent-subtle) border-(--accent) text-(--accent-text)"
              : "border-(--border-input) text-(--text-primary) hover:bg-(--bg-subtle)"
          }`}
        >
          <IconTranslate className="h-3.5 w-3.5" />
          {layout.showLabels ? currentName : shortName}
          {lanes.length > 0 && <span className="text-(--text-faint) font-normal tabular-nums">{lanes.length + 1}</span>}
          <IconChevronDown className="h-3 w-3 text-(--text-faint)" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="max-h-74 overflow-y-auto">
            <LaneRow
              name={originalName}
              detail={`${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`}
              selected={!active}
              onClick={() => {
                onSwitch(null);
                close();
              }}
            />
            {lanes.map((lane) => (
              <LaneRow
                key={lane.key}
                name={variantLabel(lane)}
                detail={`${lane.done} of ${chapterCount} ${lane.kind === "translation" ? "translated" : "rewritten"}`}
                selected={active === lane.key}
                onClick={() => {
                  onSwitch(lane.key);
                  close();
                }}
              />
            ))}
          </div>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              onAdd();
              close();
            }}
            disabled={addDisabled}
            title={addTitle}
            icon={<IconAdd className="h-3.5 w-3.5 shrink-0" />}
            testId="open-translation"
          >
            Add a translation or rewrite…
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function LaneRow({ name, detail, selected, onClick }: { name: string; detail: string; selected: boolean; onClick: () => void }) {
  return (
    // button-ok: a row in a picker marking the current value — the check is the affordance
    <button
      type="button"
      onClick={onClick}
      aria-current={selected}
      className={`flex w-full items-center gap-2.5 px-2.5 py-2 rounded-lg text-left ${
        selected ? "bg-(--accent-subtle)" : "hover:bg-(--bg-card-hover)"
      }`}
    >
      <IconCheck className={`h-3.5 w-3.5 shrink-0 ${selected ? "text-(--accent-text)" : "opacity-0"}`} />
      <span className="flex-1 min-w-0">
        <span className={`block truncate text-[13px] ${selected ? "font-bold text-(--accent-text)" : "font-medium text-(--text-primary)"}`}>{name}</span>
        <span className="block truncate text-[11.5px] text-(--text-muted)">{detail}</span>
      </span>
    </button>
  );
}
