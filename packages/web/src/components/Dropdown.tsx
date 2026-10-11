import { useState, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Menu, MenuItem } from "./Menu.tsx";
import { matchesQuery, sectionsOf } from "../lib/dropdown-sections.ts";
import { IconChevronDown } from "./icons.tsx";

export type DropdownOption = { value: string; label: string; hint?: string; disabled?: boolean; group?: string;
  // For rows that act on the menu rather than choose from it — the model pickers' "Show all" — so
  // selecting one does not dismiss the list the user is trying to open.
  keepOpen?: boolean };

// A select that looks like the app's other menus. Options carry a `group` for headed sections, and
// the trigger keeps the caller's testid so tests click it and then `<testId>-option-<value>`.
export function Dropdown({
  value,
  options,
  onChange,
  testId,
  placeholder = "Choose…",
  title,
  disabled = false,
  size = "md",
  fill = false,
  placement = "below",
  align = "left",
  width = "w-72",
  icon,
  searchable = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  testId: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  fill?: boolean;
  placement?: "below" | "above";
  align?: "left" | "right";
  width?: string;
  icon?: ReactNode;
  // A search field above the rows, for a list too long to scan — a provider's whole catalogue
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const active = options.find((o) => o.value === value);
  // A row that acts on the menu stays whatever the search says: it is how the long list opened
  const visible = searchable && query.trim() ? options.filter((o) => o.keepOpen || matchesQuery(o, query)) : options;
  const sections = sectionsOf(visible);
  return (
    <Menu
      testId={`${testId}-menu`}
      width={fill ? "w-full" : width}
      placement={placement}
      align={align}
      trigger={({ open, toggle }) => (
        <Button
          type="button"
          size={size}
          onClick={toggle}
          disabled={disabled}
          title={title ?? active?.hint}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={fill ? "w-full justify-between" : "max-w-60"}
          data-testid={testId}
          data-value={active?.value ?? ""}
        >
          {icon}
          <span className="truncate">{active?.label ?? placeholder}</span>
          <IconChevronDown className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        </Button>
      )}
    >
      {(close) => (
        <div className="max-h-80 overflow-y-auto py-1" role="listbox">
          {searchable && (
            <div className="px-2 pb-1 pt-1">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
                placeholder="Search…"
                className="w-full px-2 py-1 text-xs rounded-md border border-(--border-input) bg-(--bg-card) text-(--text-primary) outline-none"
                data-testid={`${testId}-search`}
              />
            </div>
          )}
          {sections.length === 0 && <div className="px-3 py-2 text-xs text-(--text-faint)">Nothing matches</div>}
          {sections.map((section, index) => (
            // Keyed by position: two headerless sections are ordinary (a row above the groups and
            // "Show all" below them), so the group name alone is not unique.
            <div key={`${section.group}-${index}`}>
              {section.group && <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-(--text-faint)">{section.group}</div>}
              {section.options.map((o) => (
                <MenuItem
                  key={o.value}
                  onClick={() => { onChange(o.value); if (!o.keepOpen) { setQuery(""); close(); } }}
                  title={o.hint}
                  disabled={o.disabled}
                  testId={`${testId}-option-${o.value}`}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={o.value === value ? "font-medium text-(--accent-text)" : ""}>{o.label}</span>
                    {o.hint && <span className="shrink-0 text-[11px] text-(--text-faint)">{o.hint}</span>}
                  </span>
                </MenuItem>
              ))}
            </div>
          ))}
        </div>
      )}
    </Menu>
  );
}
