# Task: a SegmentedControl, because `button-ok` is counting the reasons not to have one

## What the simplify pass found

Three of four cleanup agents arrived at the same place from different angles, which is usually the
sign that a thing is real rather than a coincidence of taste.

`button-ok` is used 14 times. **Eight of those are the same widget** — a segmented control — written
four separate times:

| where | container | selected | unselected |
| --- | --- | --- | --- |
| `BookDetail.tsx:941,957` (create tabs) | `inline-flex rounded-lg bg-(--bg-subtle) border p-1 gap-1` | `bg-(--bg-card) shadow-sm text-(--accent-text)` | `text-(--text-muted) hover:text-(--text-secondary)` |
| `BookDetail.tsx:980,991` (timing choice) | same idea, `p-0.5 gap-0.5` | `bg-(--bg-card) shadow-sm text-(--text-primary)` | same |
| `ChapterAiModal.tsx:138` (scope toggle) | `rounded-md border p-0.5 gap-0.5` | `bg-(--bg-subtle) text-(--text-primary)` | same |
| `Reader.tsx:384` (`Segmented`) | `rounded border p-0.5` | `bg-(--accent) text-(--on-accent)` | same |

The unselected skin is byte-identical in all four. The selected skin is different in all four.

**`Reader.tsx` already extracted the component.** `function Segmented({ options, value, onChange, testId })`
is exactly the right shape; it is local to the file and never exported. The work is promotion, not
invention.

`ChapterAiModal.tsx:138` states the problem in its own opt-out reason — *"the segment skin belongs to
the group"* — and there is no group.

## Why this matters more than the line count

An escape hatch that accumulates is a design smell rather than an escape hatch. Each of those eight
sites reads as a legitimate exception on its own; the pattern is only visible when you list all
fourteen. The checker now reports `buttons ok` over five duplicated skins, so the next segmented
control gets a sixth copy with a green build — which is precisely the condition `<Button>` was built
to end, reproduced one level down.

## The shape

Promote `Reader.tsx`'s `Segmented` to `packages/web/src/components/SegmentedControl.tsx`, owning the
container and both skins, and taking `options` / `value` / `onChange` / `testId`. It sits beside
`PillToggle`, which already proves the pattern works across nine call sites.

Migrating the four sites takes the opt-out count from 14 to about 6.

## Deliberately not in scope

The remaining opt-outs are genuinely different things and should stay: `FolderPickerModal.tsx:90`
(a radio row), `VariantModal.tsx:326` and `ChapterModal.tsx:1140` (selection rows),
`VoiceLibraryModal.tsx:237,251` (a nav rail with `aria-current`), `SourceChips.tsx:50,66`
(citation chips), `PillToggle` and `VoicePicker`'s labelled field.

## Before starting

`ChapterModal.tsx`, `ChapterTable.tsx`, `VariantModal.tsx`, `VoicePicker.tsx` and `BookDetail.tsx`
were being rewritten by a parallel session when this was written. Check `git status` first: two of
the four migration targets are in that set.
