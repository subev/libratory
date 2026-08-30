import { db } from "../db.ts";
import { bookLogs } from "../schema.ts";

// Postgres foreign_key_violation: the only one book_logs can raise is a book that no longer exists.
const FK_VIOLATION = "23503";

function bookIsGone(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === FK_VIOLATION) return true;
  }
  return false;
}

export async function appendLog(bookId: string, message: string, fileIndex?: number) {
  console.log(`[book ${bookId.slice(0, 8)}] ${message}`);
  try {
    await db.insert(bookLogs).values({ bookId, message, fileIndex: fileIndex ?? null });
  } catch (err) {
    // A book deleted while its job was still running leaves the line nowhere to go. Throwing here
    // aborted the startup sweep before it could recover anyone else's stranded work.
    if (!bookIsGone(err)) throw err;
  }
}
