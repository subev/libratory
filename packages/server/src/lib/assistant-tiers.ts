// The assistant panel calls the same tools an outside agent gets over /mcp: no tool is built for
// the panel alone, and there is no delete tool. What differs is who has to say yes first, and
// that is the tier. Dependency-free on purpose — the web panel imports it to draw a call as a
// trace, a done card or a confirm card.
export type ToolTier =
  // Runs without asking; the panel shows a one-line trace
  | "read"
  // Small and reversible: runs straight away, shown as done with Undo
  | "quick"
  // Changes something: a card with Run / Cancel
  | "confirm"
  // Spends credit or downloads: the same card with a cost line
  | "spend";

// Every tool the MCP server registers must be here — assistant-tools.test.ts lists the server's
// tools and fails on one that is missing, so a new tool cannot reach the panel unclassified.
export const TOOL_TIERS = {
  list_books: "read",
  get_book: "read",
  wait_for_book: "read",
  get_book_text: "read",
  get_chapter: "read",
  inspect_pdf: "read",
  list_voices: "read",
  get_capabilities: "read",
  search_library: "read",
  // The library chat's neighbour-expansion on a cited passage; only here with the chat's search
  read_passage: "read",
  list_notes: "read",
  save_note: "quick",
  update_chapter: "quick",
  set_book_settings: "quick",
  manage_folder: "quick",
  // The panel's own: takes the person somewhere in the app. Changes nothing, so it runs
  show_in_app: "quick",
  upload_book: "confirm",
  create_book: "confirm",
  extract_book: "confirm",
  redetect_chapters: "confirm",
  assemble_book: "confirm",
  export_book: "confirm",
  cancel_book: "confirm",
  synthesize_book: "confirm",
  cleanup_chapters: "spend",
  // Every chapter's text through the AI model, a translation or a rewrite
  translate_book: "spend",
  // The panel's own: Ask AI as a tool — the whole text goes to the model, so it costs
  analyze_text: "spend",
  start_download: "spend",
} as const satisfies Record<string, ToolTier>;

export type AssistantToolName = keyof typeof TOOL_TIERS;

export function isAssistantTool(name: string): name is AssistantToolName {
  return Object.hasOwn(TOOL_TIERS, name);
}

// The tiers that run without a card: what the model may call and have answered in the same turn
export const AUTO_TIERS: ReadonlySet<ToolTier> = new Set(["read", "quick"]);

// The tier of one call. A few tools straddle two: renaming a chapter is undone in a click,
// replacing its text is not; a folder is made in a click, but nothing here unmakes one.
export function tierOf(name: AssistantToolName, input: Record<string, unknown>): ToolTier {
  switch (name) {
    case "update_chapter":
      return input.text !== undefined ? "confirm" : "quick";
    case "set_book_settings": {
      const touched = Object.keys(input).filter((k) => k !== "id" && input[k] !== undefined);
      return touched.every((k) => k === "title" || k === "folder" || k === "author") ? "quick" : "confirm";
    }
    case "manage_folder":
      return input.action === "create" ? "confirm" : "quick";
    case "redetect_chapters":
      return input.llmChapterDetection === true ? "spend" : "confirm";
    case "upload_book":
      return input.ocrEngine === "llm" ? "spend" : "confirm";
    case "extract_book":
      return input.ocrEngine === "llm" ? "spend" : "confirm";
    default:
      return TOOL_TIERS[name];
  }
}

// A quick tool answers with the call that reverses it, when one exists; the card's Undo is that
// call, run by the server. Absent when nothing reverses the change (a saved note has no delete).
export type UndoCall = { tool: AssistantToolName; input: Record<string, unknown> };

export function undoOf(output: unknown): UndoCall | null {
  if (!output || typeof output !== "object" || !("undo" in output)) return null;
  const undo = (output as { undo?: unknown }).undo;
  if (!undo || typeof undo !== "object") return null;
  const { tool, input } = undo as Partial<UndoCall>;
  return typeof tool === "string" && isAssistantTool(tool) && input && typeof input === "object" ? { tool, input } : null;
}
