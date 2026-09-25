# Assistant panel

From the Claude Design handoff "Libratory desktop" (exported 2026-09-25). The design reference is
`tasks/assistant-panel/Assistant Panel.dc.html` (open it in a browser; section 1a is a clickable
prototype driven by its Demo menu, section 2 is the action sheet) with `support.js` beside it.
It is a reference, not production code: rebuild it in `packages/web` with the existing components
(`Dropdown`, `ModelPicker`, `Modal`, `Button`) and the semantic tokens in `styles.css`.

A docked chat panel that teaches a newcomer the Extract → Synthesize → Output loop and does the
work for them through the same tools `lib/mcp-server.ts` exposes. Nothing is built for the panel
alone, and there is no delete tool — keep it that way.

## Where it stands

Stage 1 is on the `assistant-panel` branch (2026-09-25): the panel shell, provider setup with a
verified key (`secrets.connect`), the `/assistant` route over the MCP tools in-process
(`lib/assistant-tools.ts`, read-only tier only), threads kept in `chat_conversations` with
`kind = "assistant"`, and the next-step card. Staged files followed the same day: drop or paperclip on the thread,
chips with upload progress, `POST /upload/staged`, `staged:` references in `inspect_pdf` and
`upload_book`, claim-by-thread, 24-hour expiry and the sweep (`lib/staged-files.ts`). Not built
from the staged-file spec: the sha256 duplicate check against existing books (book files carry no
hash), folder drops (the library page scans folders, the panel takes files), and the chip's own
`inspect_pdf` run — the model inspects on send instead. Open from that pass: the next-step card
shows only on an empty thread; a run started in another window is not followed; the library
header does not shorten its labels when the panel takes 392px of a 1100px window.

Stage 2 followed (same day): every tool reaches the panel. Read and quick tiers run in the turn;
confirm and spend tiers end the turn as a card (the SDK's `toolApproval`, per call), Run or Cancel
continues the same answer, quick edits carry an Undo the server runs, and `manage_folder`
(create, rename, move; never delete) joined the MCP set. Verified end to end: a dropped PDF became
a book in a new folder through the card. Not built from the stage-2 spec: cost estimates on the
cards, "Try one chapter" on narration, the cloud-voice check on `synthesize_book` (the tier table
cannot see the book's voice), the up/down file order on a combine card, and the collapsed rail's
"1 tip". Stage 4 and navigation followed (same day): a card restored after a reload is checked against the
book and drawn "Out of date" when the book moved on; a run started in another window is followed
poll by poll; an answer with neither words nor a call is kept as failed with a Retry; the collapsed
rail shows "1 tip" while a step is owed; the panel is resizable; and `show_in_app` takes the person
to a book, a tab, a dialog (the book page now opens its four dialogs from `?dialog=`), a chapter or
the reader. Verified in the browser: "open the extract dialog for Tiny Book" landed on the book with
the dialog open. Later the same evening: the chat's cited search inside the panel (scoped to the book on screen),
a collapsed "Thinking…" line with a sweep, folder drops, chip reordering and a one-book-or-many
choice sent with the question. Verified in the browser on the Playbook book: a quote question
answered with numbered citations and a source list opening the reader; two files dropped showed
the choice and reordered.

The three AI features became one the same night. Ask AI is the `analyze_text` tool: the preset
chips on a book page ("Summarize", "Did you know?") become a spend card, the whole text goes to
the model, the answer is saved as a note and drawn as one with "Add as chapter"; the chapter
modal's Ask AI button stays. A thread's sources are a chip in the header (follow the page, or the
chat's picker); a new thread inside one carries its sources; one whose sources are all gone is
read, not continued. The library chat page was first made the assistant full width, then dropped altogether: the
panel is the one chat, the "Chat" links on the library and book headers are gone (the Assistant
toggle beside them is the way in), past threads and saved answers sit behind the panel's History
button, every conversation is `kind: "assistant"` (migrations 0043 and 0044), and `POST /chat`
stays only as the search half's test harness. "Save as note" sits under every
finished answer. The e2e chat specs were moved onto the new test ids, and the upload helper is
scoped to the upload dialog because the panel beside the library carries a file input of its own.

Later that night the last two entrances went the same way. Every Ask AI button on the book page
(header, the raw-text hint, the chapter tray, a chapter row, the chapter modal) pins the book or
the chapters to the assistant: a chip under the composer with the preset chips beside it, the
pinned text named in the question with its ids (`describeRead`), and the model answering with
`analyze_text`. `ChapterAiModal` and `POST /chat/ask` are gone. The sources chip names what a
question would search right now — the book on screen, or "Whole library" — instead of the rule
"Follows the page". A finished answer refetches the page's queries, so a note, a rename or a
new folder shows without a reload (the e2e caught the Notes tab not appearing).

Still open: cost lines and "Try one chapter" on cards, the cloud-voice check on narration, the
duplicate check against existing books, the crowded headers beside the panel, checking the
provider copy before release.

## Build order

1. **Panel shell and provider setup.** Dock, collapse, the provider tiles with three steps to get
   a key. Reads and writes the same key store as `SettingsModal` (`lib/secrets.ts`). Wire the
   read-only tools only.
2. **Action cards** for the tools that change something (confirm / undo / cost).
3. **Staged files**: drop and paperclip, chips, `staged:` ids, cleanup.
4. **Persistence**: restoring the thread after a reload, pending and out-of-date cards, history.

## Decisions

| Topic | Decision |
|---|---|
| Placement | Right-side panel, 392px, open on first launch. Collapses to a 48px rail; the toolbar "Assistant" button toggles it. Open/collapsed is saved locally. |
| Before a key | The panel shows only setup: five tiles (DeepSeek recommended, OpenAI, Anthropic, Google Gemini, On this Mac). Text box, send and paperclip disabled. Dropping files is off until a model is connected. |
| Key setup | Three inline steps: open the provider's page, create a key (prefix shown), paste. Plus a cost line. **Verify the URLs, button names, prefixes and pricing wording against each provider before shipping.** |
| Key check | Connect sends one test request. On failure: "‹Provider› rejected this key…", nothing is saved, the field turns red, the button reads "Try again". |
| On this Mac | Detects Ollama / LM Studio (the existing `llm.ts` discovery) and lists its models as radio options. Free, private, slower. |
| Voice | Plain and brief, like app copy. |
| Screen context | Every turn sends the current route, the book id if any, the book's status (text extracted, chapter count, narration progress, pending jobs) and the provider/model. A chip in the header shows which page it is on. |
| Next step | On a book page the first view is a "Next step for this book" card with one primary action and two suggested questions. The three-step list appears only when asked. The collapsed rail shows "1 tip" only while a step is still to be taken. |
| Tools | The same tools as `lib/mcp-server.ts`, called in-process (a new chat route like `/chat`, not `/mcp`). |

## Rules per tool

| Tier | Tools | UI |
|---|---|---|
| Read-only, runs without asking | list_books, get_book, wait_for_book, get_book_text, get_chapter, inspect_pdf, list_voices, get_capabilities, search_library, list_notes | A one-line trace ("Checked 3 PDFs") that opens to show the calls. |
| Small and reversible, runs straight away | update_chapter (title / selected), set_book_settings (title, folder), save_note | A "Done" card with **Undo**. Undo lasts until the next message. |
| Changes something, needs OK | upload_book, create_book, update_chapter (text), extract_book, redetect_chapters (no AI), set_book_settings (voice, language, OCR engine, speed), assemble_book, export_book, cancel_book | A card with fields, a note and **Run / Cancel**, then running → done / failed. |
| Spends credit or downloads | synthesize_book with a cloud voice, cleanup_chapters, redetect_chapters with AI, upload_book with `ocrEngine: llm`, start_download | As above plus a warning-coloured cost line. Cloud narration also offers "Try one chapter". |

- Running actions are server jobs: closing the panel or reloading the page does not stop them.
  The card picks progress up again from `get_book`.
- After Done, the assistant suggests the next step in the loop (extract → synthesize → assemble /
  export).
- Failures say what happened and what is kept: "Stopped at chapter 5: ElevenLabs says the account
  is out of credit. Chapters 1–4 keep their audio." They offer Resume or a free alternative.

## Staged files (drop or paperclip)

- Only when a model is connected. Drop anywhere on the panel (overlay: "Drop to add 3 PDFs"), or
  the paperclip in the text box.
- The web app uploads each file to `data/tmp/staged/<profile>/<id>` and gets back `staged:<id>`.
  **Backend change:** `inspect_pdf` and `upload_book` accept `staged:` ids alongside absolute
  paths, resolved on the server. The model never sees file-system paths.
- Chip states: uploading (%), reading (`inspect_pdf` runs by itself), ready (page count; details
  in the tooltip), ready + **Scan** label, refused ("Not a PDF", nothing uploaded), upload
  interrupted, expired. Send waits until every chip has finished uploading.
- The assistant then suggests **Create N books** / **Combine into one** (title, file order with
  up/down; `upload_book` with `paths[]` in order) / **Edit titles first**. It suggests Combine
  first only when the files look like volumes (same author, numbered names).
- From the panel `upload_book` runs with `fullExtract=false`: a text-only book readable in
  seconds, then the assistant suggests the next step. It never runs the unattended full pipeline.
- Scans: the assistant asks about the OCR engine and the language pack (`start_download`) before
  extraction.

### Cleanup

Each staged file has a record: id, profile, thread id, message id, name, size, sha256, status
(`uploading | ready | used | removed | expired`), createdAt, lastActivityAt.

| When | What happens |
|---|---|
| Book created | `upload_book` copies the file, then the staged copy is deleted and the status set to `used`. |
| Chip removed (×) | Deleted immediately. |
| Page reloads mid-upload | The partial file is discarded. The chip shows "Upload interrupted · drop again". No resumable uploads. |
| Thread deleted | Its staged files go with it. |
| Chat abandoned | Kept 24 hours after the thread's last activity (the clock restarts when the user comes back), then expired. |
| Cleanup job | Runs at server start and then hourly: deletes expired files, files with no record, records with no file. |
| Space limit | About 2 GB of staged files per profile. Past that new drops are refused with a message; nothing is silently deleted. |
| Duplicate | If the sha256 matches an existing book's file, the assistant says "Already in your library as …" and does not stage it. |

## Persistence and reloads

- Assistant threads are saved on the server in the chat history store (`chat_conversations`),
  marked as assistant chats and scoped to the profile. Reloading reopens the same thread at the
  same scroll position.
- Reopening the panel reopens the last thread if it was active in the past 24 hours; otherwise it
  starts a new one. The header has **Past assistant chats** and **New chat**.
- **Streaming reply cut off:** reuses the chat history's interrupted state ("Answer interrupted by
  a page reload · Retry").
- **Card waiting for OK:** saved as pending. On reload the book state is checked again; if it
  changed (chapters extracted by hand, say) the card becomes **Out of date** (grey, no buttons,
  one-line reason) and the assistant adds a fresh line saying what is true now. Saved messages
  always render as they were written.
- **Key removed later:** old threads stay readable; the text box locks with a link to setup.

## Demo menu → screens

1. Empty library, no key · 2. Key pasted / checking · 3. Key failed / model on this Mac · 4. First
unlocked conversation, dragging PDFs, PDFs dropped (how to add them?), books created, combine into
one, combined book created · 5. Book page first look, asked how to make an audiobook · 6. Confirm →
running → done · 7. Collapsed · 8. After a page reload.

## Tokens

Semantic tokens from `styles.css` only: `--bg-page`, `--bg-card`, `--bg-subtle`, `--bg-selected`,
`--border`, `--border-input`, `--text-primary…faint`, `--accent`, `--accent-text`,
`--accent-subtle`, `--on-accent`, `--success-*`, `--warning-*`, `--danger-*`. System sans for the
interface, Fraunces 600 for the panel title and headings. Base text 14px. Card radius 10px, button
radius 7px, chip height 28px (buttons and single-line chips never wrap; they truncate with a
tooltip). The prototype's own radii and sizes yield to `Button` and the spacing ladder where they
disagree.

## Open items

- Provider URLs, key prefixes and pricing wording: verify them.
- Cost estimates on the cards (ElevenLabs characters, DeepSeek cents): compute from real usage.
- The combine heuristic (one book or several) needs a backend rule.
- Dark mode: the tokens are `light-dark()` pairs so the toolbar's moon toggle previews it. Check
  the warning line's contrast on the dark ground.
- Transport: the panel talks to the tools in-process from the web app, so it needs a streaming
  route beside `POST /chat` rather than `/mcp`, and a tool-tier table on the server so the
  confirm gate cannot be bypassed by the model.
