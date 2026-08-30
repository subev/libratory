import { useCallback, useEffect, useRef, useState } from "react";
import { THEMES, loadTheme, saveTheme, type Theme } from "../lib/theme.ts";
import { useDismissOnOutsidePointer, useTopmostEscape } from "./Modal.tsx";
import { IconCheck, IconChevronDown, IconThemeDark, IconThemeLight } from "./icons.tsx";
import { Button } from "./Button.tsx";

const LABEL: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

// A monitor reads as "auto" only to someone who already knows the convention. The sun and moon do
// not need explaining, so auto borrows whichever one it is following and marks itself with an "A".
function ThemeGlyph({ theme, systemDark, className = "" }: { theme: Theme; systemDark: boolean; className?: string }) {
  const Icon = theme === "dark" || (theme === "auto" && systemDark) ? IconThemeDark : IconThemeLight;
  if (theme !== "auto") return <Icon className={`h-4 w-4 shrink-0 ${className}`} />;

  return (
    <span className={`relative inline-block shrink-0 h-4 w-4 ${className}`}>
      <Icon className="absolute top-0 left-0 h-3.5 w-3.5" />
      <span aria-hidden className="absolute -right-0.5 -bottom-0.5 text-[8px] font-bold leading-none">
        A
      </span>
    </span>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useTopmostEscape(close, open);
  useDismissOnOutsidePointer(root, close, open);

  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const sync = () => setSystemDark(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const describe = (t: Theme) => {
    if (t === "light") return "Cream paper, always";
    if (t === "dark") return "Charcoal paper, always";
    return `Follows your system appearance — ${systemDark ? "dark" : "light"} right now`;
  };

  function pick(next: Theme) {
    saveTheme(next);
    setTheme(next);
    close();
  }

  return (
    <div ref={root} className="relative ml-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="theme-menu"
        title={`Appearance: ${LABEL[theme]}`}
        aria-label={`Appearance: ${LABEL[theme]}`}
        data-testid="theme-toggle"
      >
        <ThemeGlyph theme={theme} systemDark={systemDark} />
        <IconChevronDown className="h-3 w-3 text-(--text-faint)" />
      </Button>

      {open && (
        <div
          id="theme-menu"
          className="absolute right-0 top-full mt-1.5 z-50 w-67 p-1.5 rounded-xl border border-(--border) bg-(--bg-card) shadow-2xl"
          data-testid="theme-menu"
        >
          <p id="theme-menu-label" className="px-2.5 pt-1 pb-2 text-[10px] font-bold tracking-widest uppercase text-(--text-faint)">
            Appearance
          </p>
          <div role="radiogroup" aria-labelledby="theme-menu-label">
            {THEMES.map((t) => {
              const on = t === theme;
              return (
                // button-ok: a radio picks a preference, it does not act
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(t)}
                  className={`flex w-full items-start gap-2.5 px-2.5 py-2 rounded-lg text-left ${
                    on ? "bg-(--accent-subtle) text-(--accent-text)" : "text-(--text-primary) hover:bg-(--bg-card-hover)"
                  }`}
                  data-testid={`theme-${t}`}
                >
                  <ThemeGlyph theme={t} systemDark={systemDark} className={`mt-0.5 ${on ? "" : "text-(--text-muted)"}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-semibold">{LABEL[t]}</span>
                    <span className={`block text-[11.5px] leading-snug ${on ? "opacity-85" : "text-(--text-muted)"}`}>
                      {describe(t)}
                    </span>
                  </span>
                  {on && <IconCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
