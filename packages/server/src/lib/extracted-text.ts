// A block owns its paragraph boundary; printed line wrapping does not belong in reading text.
export function cleanText(text: string): string {
  return text
    .replace(/\u00ad[ \t]*\r?\n[ \t]*/g, "")
    .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(?=\p{L})/gu, "$1")
    .replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


export const TEXT_KINDS = ["prose", "verse", "heading", "list", "footnote", "metadata", "furniture"] as const;
export type TextKind = typeof TEXT_KINDS[number];

export type TextBlock = { text: string; kind?: TextKind; breakBefore?: "line"; included?: boolean };

export function joinTextBlocks(blocks: TextBlock[]) {
  let text = "";
  const spans: { block: number; start: number; end: number }[] = [];
  let previous: TextBlock | undefined;
  for (const [block, source] of blocks.entries()) {
    if (source.included === false || !source.text) continue;
    if (previous) text += source.breakBefore === "line" && source.kind === "verse" && previous.kind === "verse" ? "\n" : "\n\n";
    const start = text.length;
    text += source.text;
    spans.push({ block, start, end: text.length });
    previous = source;
  }
  return { text, spans };
}

export function formatExtractedText(text: string, kind?: TextKind): string {
  if (kind !== "verse") return cleanText(text);
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/\u00ad|\u200b|\u200c|\u200d|\ufeff/g, "").replace(/[ \t]+/g, " ").trim())
    .join("\n").trim();
}
