import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractPdfRawText(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = stdout.replace(/[ \t]+\n/g, "\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

// Producers write their own name into /Author often enough that a shelf sorted by it would be
// sorted by software; those, and anything that reads like a path or a filename, are not a person.
const NOT_A_PERSON = /^(user|admin|owner|unknown|author|microsoft|adobe|acrobat|word|pdf|scanner|hp|canon|epson|xerox)\b/i;

export async function extractPdfAuthor(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath], { timeout: 15_000 });
    const author = stdout.match(/^Author:\s*(.+)$/m)?.[1]?.trim() ?? "";
    if (author.length < 2 || author.length > 120) return null;
    if (NOT_A_PERSON.test(author) || /[\\/]|\.pdf$/i.test(author)) return null;
    return author;
  } catch {
    return null;
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
