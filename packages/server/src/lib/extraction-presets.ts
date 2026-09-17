import { z } from "zod";

export const STANDARD_EXTRACTION_PROMPT = `You transcribe one scanned book page from its image into structured JSON. Rules:
- Transcribe the body text verbatim, in the page's own language and script. Do not translate, summarise, modernise spelling, or fix the author's wording. Keep the original punctuation.
- Start at the very first line of text on the page and stop at the last. A page usually begins with the tail of a sentence from the previous page — a fragment with no indent and no capital letter. That fragment is the first block; never skip it to start at the first indented paragraph.
- Every line of body text must appear in some block. Do not omit, shorten or merge passages.
- A word split across two lines by a hyphen at the line end is one word: write it joined, with no hyphen and no space. Keep a hyphen only when it is part of the word itself or a dash between words.
- One block per paragraph; join the lines of a paragraph with single spaces. Keep paragraph breaks as separate blocks.
- Headings (chapter titles, section titles) are blocks of type "heading" with a level: 1 for a chapter or part title, 2 for a section, 3 for a subsection.
- List items are blocks of type "list_item", one per item.
- Footnotes, captions, tables and poetry are blocks of type "other", kept verbatim.
- Running headers, running footers, page numbers, signature marks and printer's marks go into "furniture", one string each, verbatim. Never put them into a block and never drop them.
- "continues" is true when the last body block on the page ends mid-sentence or mid-paragraph and carries on at the top of the next page; false when the page ends at a paragraph end.
- If the page is blank or has no text, return an empty blocks list.
Return only the JSON object.`;

export const extractionSettingsSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  lineOrdering: z.boolean(),
  orderingPrompt: z.string().trim().max(10000),
  omitVerseCounters: z.boolean().optional(),
});
export type ExtractionSettings = z.infer<typeof extractionSettingsSchema>;
export const STANDARD_EXTRACTION: ExtractionSettings = { prompt: STANDARD_EXTRACTION_PROMPT, lineOrdering: false, orderingPrompt: "" };
export const EXTRACTION_PRESETS = [
  { id: "standard", name: "Standard", settings: STANDARD_EXTRACTION, builtIn: true },
  { id: "columns-poetry", name: "Columns and poetry", builtIn: true, settings: {
    ...STANDARD_EXTRACTION, lineOrdering: true,
    orderingPrompt: "Keep each verse column as a separate group. Read the left verse then the right verse, then collection date/location, attribution and performance notes. Finish a page-opening verse continuation before its metadata. Keep headings separate and prose and footnotes in their printed order.",
  } },
];
