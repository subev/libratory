# Task: what the book-page shell left on the floor

The `book-detail-shell` branch reorganised the book page into a fixed-viewport shell (Source files /
Chapters / Outputs / Notes). These are the things the design draws, or the redesign wanted, that have
nothing behind them yet. None of them blocked the branch; all of them are cheap once someone wants them.

## Drawn in the artboard, unbacked in the app

- **A `Stop` on the assembling row.** `books.cancel` suspends non-done *chapters*; nothing cancels an
  assembly job. The progress row is drawn without the button rather than with a dead one.
- **Per-file page counts** (`412 pages · …`). `book_files` has no page column; `books.get` returns
  `rawWords` only. A per-source `pageCount` exists in the reader payload (`lib/reader-format.ts`,
  from a disk sidecar) and would have to be surfaced.
- **Byte size on assemblies and documents** (`612 MB`). Neither table has a size column; sizes exist
  only bucketed in `books.diskUsage`. The Export modal's size/time estimate is missing for the same
  reason.
- **Per-lane duration in the variant menu** (`71 chapters · 18h 42m`). `variants.list` returns
  `{key, kind, label, total, done}` — no duration, and no per-lane *running* flag, so the design's
  working dot cannot be drawn either.
- **`Added as chapter 72`.** `notes` has no back-reference to the chapter `notes.toChapter` creates;
  today's confirmation is client-only and lost on remount.
- **A drop zone on the Source files tab.** `BookFilesSection` has an `AddFilesButton` with a hidden
  input; `UploadZone` is Home-only.
- **`Reveal in Finder` on an output row.** The artboard puts it between Download and Delete on every
  assembly and document. The web package has no bridge to the desktop shell, so there is nothing to
  call.

## Known exception to the portal rule

`voice-picker/VoiceLibraryModal.tsx` hand-rolls `fixed inset-0 z-[70]` instead of going through
`Modal`, so it gets neither the body portal nor the escape stack. `ChapterTable` renders it (as
`SynthesizeModal`) inside the Chapters panel, so it is one tab-switch away from the bug the portal
cures — it is unreachable today only because the chapter modal's scrim covers the tab bar. Route it
through `Modal` when someone next touches the voice picker.

## The library page's own leftovers

- **Rename a book from the row menu.** The artboard puts `Rename…` between Move and Delete. Folder
  rows rename in place with an input; book rows are rendered inline in a `.map()` with no per-row
  state to flip, so it needs a `BookTableRow` extraction or a small rename dialog first. New
  functionality either way — nothing was lost.
- **The row overflow menu can be clipped by the list's own scroller.** `Menu` positions absolutely
  and the list is now `overflow-y-auto`, so for the last rows the popover contributes to scroll
  overflow rather than opening over the tray. It is reachable by scrolling, not lost. A real fix is
  either a portal in `Menu` or a placement that flips near the bottom edge; the book page's tray
  sidesteps it with a fixed `placement="above"`, which a row cannot use because rows near the top
  would clip the other way.
- **A chip can read 0 while a folder row is still visible.** The chips count books at this level;
  a folder survives on its subtree, which is what was asked for. In a folder-only view that reads as
  "Working 0" above a visible folder. Folding subtree counts into the chips would make "All" disagree
  with the list instead, so this stays until someone decides which number the chip is promising.
- **The profile menu restyle.** The artboard redraws `ProfileSwitcher` at 304px with rename and
  delete inline per row and a "New profile" footer. All of that already works in its own popover;
  this is the lowest-value part of the redesign and the only piece of the library artboard not built.

## Deliberately not built

- **"Manage versions…"** — the artboard's variant menu ends with it, but renaming and deleting a lane
  do not exist. It would need `variants.rename` / `variants.delete`, and delete has to reach the
  lane's chapters, audio and assemblies. Dropped rather than drawn.
- **The Export "From" scope toggle.** The artboard offers `All 71` vs `Selected 34`; the app has one
  selection — the chapter checkboxes every action reads — and a second scope only Export understood
  could disagree with the table behind it. The row is a read-only per-format summary instead.

## Also parked

- `Components.tsx` does not render the shell's primitives (`SegmentedControl`, `Menu`, `ResourceRow`,
  `StageTabs`). It could not show `Section` either, which is part of why the stripe drifted.
- The two `@slow` e2e specs (`uc1` assemble, `uc6` documents) were updated for the tray and the export
  modal but have not been run against them.
