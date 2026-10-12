# Review: row menus clipped by the table wrapper (2026-10-12)

Scope: `packages/web/src/components/Menu.tsx` and the matching line in `AGENTS.md`. One
commit on top of 6b9d4b5. Reviewed in-context against the full file, then exercised in a
browser against the dev server.

## Defect

The library table's wrapper is `overflow-x-auto`, which makes the vertical axis `auto`
too, so an `absolute` popover anchored inside it is clipped at the table's bottom edge.
The last rows' "…" menus showed as a sliver. The chapter table (`overflow-auto`) had the
same exposure; the shelf page worked around it in 6b9d4b5 by dropping `overflow-hidden`.

## Change

- `Menu.tsx:9-29` — `placePanel` turns the trigger's rect into fixed coordinates and flips
  to the other side when the requested one does not fit and the other does.
- `Menu.tsx:66-89` — the position is written onto the panel from a layout effect, with the
  panel hidden until measured; it follows ancestor scroll, window resize and its own size.
- `Menu.tsx:59, 137, 151` — the portal host is the enclosing `[role="dialog"]` when there is one
  (aria-modal hides anything outside it from assistive tech), else the body; read from the
  click event because the lint forbids ref reads in render.
- `Menu.tsx:107-108` — outside-pointer dismissal treats the portalled panel as inside.
- `Menu.tsx:145` — `z-[70]`, above the Modal's `z-[60]`.

## Findings

- Menu `width="w-full"` (Dropdown `fill`) would have been meaningless on a body-level panel.
  Fixed: the panel takes the trigger's measured width.
- A Dropdown whose list grows after opening ("Show all N models") could run past the
  viewport bottom. Fixed: a ResizeObserver re-places the panel.
- `host` is only set by a click on the trigger wrapper. Every trigger today opens on click,
  but a future keyboard-driven one would have rendered nothing. Fixed: falls back to the body.
- No remaining findings. The shelf page could take its `overflow-hidden` back now; left as is.

## Verification

- `tsc --noEmit`, `pnpm lint` (no errors), web vitest: 30 files, 166 tests.
- Browser (vite on 3033 against the running API): last library row's menu renders fully,
  flipped above its trigger; tray "More" still opens upward; Settings' full-width model
  picker keeps the trigger width, paints over the dialog, grows in place on "Show all", and
  is inside the dialog's subtree; a click elsewhere in the dialog closes only the menu.
- Not run: e2e smoke — the API port is held by the desktop app, and the tests would write
  into its library. CI runs them on push.
