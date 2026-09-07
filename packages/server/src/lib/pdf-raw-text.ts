import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// One pdftotext run behind both questions below. Null means the tool could not be run at all, which
// has to stay distinguishable from "it ran and the pages were empty": failing an extraction on the
// first would break every book on a machine missing poppler rather than the one scanned PDF.
async function pdfToText(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"], {
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function extractPdfRawText(pdfPath: string): Promise<string | null> {
  const stdout = await pdfToText(pdfPath);
  return stdout === null ? null : stdout.replace(/[ \t]+\n/g, "\n").trim() || null;
}

export async function pdfHasTextLayer(pdfPath: string): Promise<boolean | null> {
  const stdout = await pdfToText(pdfPath);
  return stdout === null ? null : stdout.trim().length > 0;
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
