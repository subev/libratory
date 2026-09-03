import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Menu, MenuDivider, MenuItem } from "./Menu.tsx";
import { IconChevronUp } from "./icons.tsx";

export type TrayAction = {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  /** Survives the collapse — the primary verb and anything whose absence is information. */
  pinned?: boolean;
};

// Pinned under the table it acts on, because the toolbar used to scroll away from its own selection.
export function ActionTray({
  title,
  subtitle,
  actions,
  primary,
  compact,
}: {
  title: string;
  subtitle: string;
  actions: TrayAction[];
  primary: ReactNode;
  /** Both shells derive this from their own width contract; the tray does not know either. */
  compact: boolean;
}) {
  const shown = compact ? actions.filter((a) => a.pinned) : actions;
  const collapsed = compact ? actions.filter((a) => !a.pinned) : [];

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-(--border) bg-(--bg-card)" data-testid="action-tray">
      <span className={`flex flex-col ${compact ? "min-w-32" : "min-w-44"}`}>
        <span className="text-xs font-bold text-(--text-primary)">{title}</span>
        <span className="text-[11px] text-(--text-muted)">{subtitle}</span>
      </span>
      <div className="flex-1" />

      {shown.map((action) =>
        // Two spellings rather than a computed variant: Button's type admits `soft` on the four
        // variants that have a quiet register, and a union of variants cannot prove which it is.
        action.danger ? (
          <Button
            key={action.id}
            variant="danger"
            soft
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            data-testid={`tray-${action.id}`}
          >
            {action.label}
          </Button>
        ) : (
          <Button
            key={action.id}
            variant="secondary"
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            data-testid={`tray-${action.id}`}
          >
            {action.label}
          </Button>
        ),
      )}

      {collapsed.length > 0 && (
        <Menu
          align="right"
          placement="above"
          testId="tray-more"
          trigger={({ open, toggle }) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={toggle}
              aria-expanded={open}
              title={collapsed.map((a) => a.label).join(", ")}
              data-testid="tray-more-trigger"
            >
              More
              <IconChevronUp className="h-3 w-3" />
            </Button>
          )}
        >
          {(close) => (
            <>
              {collapsed
                .filter((a) => !a.danger)
                .map((action) => (
                  <MenuItem
                    key={action.id}
                    onClick={() => {
                      action.onClick();
                      close();
                    }}
                    disabled={action.disabled}
                    title={action.title}
                    testId={`tray-${action.id}`}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              {collapsed.some((a) => a.danger) && <MenuDivider />}
              {collapsed
                .filter((a) => a.danger)
                .map((action) => (
                  <MenuItem
                    key={action.id}
                    onClick={() => {
                      action.onClick();
                      close();
                    }}
                    disabled={action.disabled}
                    title={action.title}
                    danger
                    testId={`tray-${action.id}`}
                  >
                    {action.label}
                  </MenuItem>
                ))}
            </>
          )}
        </Menu>
      )}

      <div className="w-px h-5 bg-(--border) mx-1" />
      {primary}
    </div>
  );
}
