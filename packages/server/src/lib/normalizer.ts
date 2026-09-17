import { joinTextBlocks, type TextBlock } from "./extracted-text.ts";

export function normalizeForTts(text: string, options: { preserveVerse?: boolean } = {}): string {
  let out = text;

  // Strip markdown bold/italic
  out = out.replace(/\*\*(.+?)\*\*/g, "$1");
  out = out.replace(/\*(.+?)\*/g, "$1");
  out = out.replace(/(?<![\w])_([^_\n]+)_(?!\w)/g, "$1");

  // Strip markdown inline code
  out = out.replace(/`(.+?)`/g, "$1");

  // Strip markdown images (must run before link strip)
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");

  // Strip markdown links: [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Strip markdown headers (# ## ### etc.)
  out = out.replace(/^#{1,6}\s+/gm, "");

  // Remove reference markers like [1], [23], [iv]
  out = out.replace(/\[\d+\]/g, "");
  out = out.replace(/\[(?:i{1,3}|iv|v|vi{0,3}|ix|x{0,3})\]/gi, "");

  // Remove bare URLs, and the bracket a book wraps them in — a lone < is read as a word
  out = out.replace(/<?https?:\/\/\S+/g, "");

  // Rejoin hyphenated line breaks: "con-\n" → "con"
  if (!options.preserveVerse) out = out.replace(/(\w)-\n(\w)/g, "$1$2");

  // Collapse multiple blank lines into one
  out = out.replace(/\n{3,}/g, "\n\n");

  // Trim excessive whitespace within lines
  out = out.replace(/[ \t]+/g, " ");

  // Trim leading/trailing whitespace per line
  out = out
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  return out.trim();
}

export type BlockSpan = { block: number; start: number; end: number };

// Keep source indices while normalizing so reader offsets still point to the original blocks.
export function normalizeBlocks(blocks: (TextBlock & { included: boolean })[]): { text: string; spans: BlockSpan[] } {
  return joinTextBlocks(blocks.map((block) => ({ ...block, text: normalizeForTts(block.text, { preserveVerse: block.kind === "verse" }) })));
}
