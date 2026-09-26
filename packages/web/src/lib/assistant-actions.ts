import { TOOL_TIERS, type AssistantToolName } from "../../../server/src/lib/assistant-tiers.ts";

// What a card calls each tool, and the one line under its fields. The model already said what it
// is about to do; the card says what the app will do with it.
type Action = { label: string; note: string };

// Look-ups are traces and show_in_app is a line about where it went; neither is a card. Derived
// from the tier table, so a new read tool needs no entry here and a new acting one cannot lack one.
type CardTool = { [K in AssistantToolName]: (typeof TOOL_TIERS)[K] extends "read" ? never : K extends "show_in_app" ? never : K }[AssistantToolName];

const ACTIONS: Record<CardTool, Action> = {
  upload_book: { label: "Add a book", note: "The files are copied into the library. The text is readable in seconds; chapters come with extraction." },
  create_book: { label: "Make a book from text", note: "One chapter per entry, searchable at once. Narration is a separate step." },
  extract_book: { label: "Extract the chapters", note: "Reads the pages thoroughly and splits them into chapters. Existing chapters and their audio are replaced." },
  redetect_chapters: { label: "Find the chapters again", note: "Uses the pages already read. The current chapters and their audio are replaced." },
  cleanup_chapters: { label: "Clean up the text", note: "Sends each chapter's text to the AI model, which repairs OCR artifacts into a copy the narrator reads." },
  translate_book: { label: "Translate or rewrite the chapters", note: "Each chapter's text goes to the AI model. The new version sits beside the original in the book's language menu, ready to narrate or export." },
  synthesize_book: { label: "Narrate the chapters", note: "Runs in the background; the panel can be closed. A cloud voice is metered." },
  assemble_book: { label: "Make the audiobook", note: "Joins the narrated chapters into one M4B with chapter markers." },
  export_book: { label: "Export a document", note: "Appears under Outputs when it is done." },
  cancel_book: { label: "Stop the work", note: "Chapters keep the audio they already have." },
  set_book_settings: { label: "Change the book", note: "Audio already narrated keeps the old voice until the chapters are narrated again." },
  update_chapter: { label: "Replace the chapter's text", note: "The extracted text is kept; the narrator reads the new text after the chapter is narrated again." },
  manage_folder: { label: "Make a folder", note: "" },
  start_download: { label: "Download", note: "Hundreds of megabytes, once. Watch Settings for progress." },
  analyze_text: { label: "Read the whole text", note: "The whole text goes to the AI model with this prompt. The answer is saved as a note on the book." },
  save_note: { label: "Save a note", note: "" },
};

export function actionOf(tool: AssistantToolName): Action {
  return tool in ACTIONS ? ACTIONS[tool as keyof typeof ACTIONS] : { label: tool, note: "" };
}

// What a Done card says a quick edit did
export function doneLabel(tool: AssistantToolName, input: Record<string, unknown>): string {
  switch (tool) {
    case "set_book_settings":
      if (input.title !== undefined) return "Renamed the book";
      if (input.folder !== undefined) return input.folder === null ? "Moved the book to the top level" : "Moved the book";
      if (input.author !== undefined) return "Set the author";
      return "Changed the book";
    case "update_chapter":
      if (input.title !== undefined) return "Renamed a chapter";
      if (input.selected !== undefined) return input.selected ? "Selected a chapter" : "Excluded a chapter";
      return "Changed a chapter";
    case "manage_folder":
      return input.action === "rename" ? "Renamed the folder" : input.action === "move" ? "Moved the folder" : "Made a folder";
    case "save_note":
      return "Saved a note";
    default:
      return actionOf(tool).label;
  }
}

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  folder: "Folder",
  author: "Author",
  voice: "Voice",
  speed: "Speed",
  language: "Language",
  format: "Format",
  ocrEngine: "OCR engine",
  ocrModel: "Vision model",
  chapterModel: "Model",
  llmChapterDetection: "AI reads the contents",
  fullExtract: "Extract chapters now",
  skipSynthesis: "Narrate later",
  synthesize: "Narrate now",
  waitForAll: "Wait for narration",
  resume: "Resume",
  name: "Name",
  parent: "Parent folder",
  action: "Action",
  kind: "Kind",
  text: "Text",
  selected: "Selected",
  markdown: "Note",
  prompt: "Prompt",
  preset: "Rewrite",
  label: "Name",
};

// Hidden from the card: ids the person cannot read, and a profile the panel already fixes
const HIDDEN = new Set(["id", "bookId", "profile", "client"]);

export type Field = { label: string; value: string };

// The input as rows a person can read: names for the keys, counts for the lists, and "none"
// rather than the word null. Ids are left out — the card names the book by title instead.
export function fieldsOf(tool: AssistantToolName, input: Record<string, unknown>): Field[] {
  const rows: Field[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (HIDDEN.has(key) || value === undefined) continue;
    const label = FIELD_LABELS[key] ?? key;
    if (key === "paths" && Array.isArray(value)) rows.push({ label: "Files", value: `${value.length} PDF${value.length === 1 ? "" : "s"}` });
    else if (key === "chapters" && Array.isArray(value)) rows.push({ label: "Chapters", value: `${value.length}` });
    else if (key === "chapterIds" && Array.isArray(value)) rows.push({ label: "Chapters", value: `${value.length} chosen` });
    else if (value === null) rows.push({ label, value: "none" });
    else if (typeof value === "boolean") rows.push({ label, value: value ? "yes" : "no" });
    else if (typeof value === "string") rows.push({ label, value: value.length > 160 ? `${value.slice(0, 160)}…` : value });
    else if (typeof value === "number") rows.push({ label, value: String(value) });
    else rows.push({ label, value: JSON.stringify(value) });
  }
  if (tool === "manage_folder") return rows.filter((r) => r.label !== "Action");
  return rows;
}

// The book a call is about, when it names one, for the card's title line
export function bookIdOf(input: Record<string, unknown>): string | null {
  const id = input.bookId ?? input.id;
  return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
