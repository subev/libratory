import type { MouseEvent } from "react";

const CONTROLS = "a, button, input, select, textarea, label, [role='button'], [contenteditable='true']";

// A table row's main action on a click anywhere in it. The controls inside the row keep their own
// clicks, and a click that ends a text selection is somebody copying a title, not opening it.
export function rowClick(action: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest(CONTROLS)) return;
    if (window.getSelection()?.toString()) return;
    action();
  };
}
