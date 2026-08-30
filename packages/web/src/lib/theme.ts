export const THEMES = ["auto", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

// Also read by the pre-paint bootstraps in web/index.html and server/src/lib/chapter-reader.ts.
const KEY = "theme";

export function loadTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  return THEMES.includes(stored as Theme) ? (stored as Theme) : "auto";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}
