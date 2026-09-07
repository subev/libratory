import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Menu, MenuItem } from "./Menu.tsx";
import { IconChevronDown } from "./icons.tsx";

export type DropdownOption = { value: string; label: string; hint?: string; disabled?: boolean; group?: string };

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
}) {
  const active = options.find((o) => o.value === value);
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
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
          {groups.map((group) => (
            <div key={group}>
              {group && <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-(--text-faint)">{group}</div>}
              {options.filter((o) => (o.group ?? "") === group).map((o) => (
                <MenuItem
                  key={o.value}
                  onClick={() => { onChange(o.value); close(); }}
                  title={o.hint}
                  disabled={o.disabled}
                  testId={`${testId}-option-${o.value}`}
                >
                  <span className={o.value === value ? "font-medium text-(--accent-text)" : ""}>{o.label}</span>
                </MenuItem>
              ))}
            </div>
          ))}
        </div>
      )}
    </Menu>
  );
}
