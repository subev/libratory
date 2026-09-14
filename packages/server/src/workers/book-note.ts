import { db } from "../db.ts";
import { books, type NoteJob } from "../schema.ts";
import { eq } from "drizzle-orm";
import { contextExceeded, llmChat, resolveLlm, type LlmModelDef } from "../lib/llm.ts";
import { describeError } from "../lib/errors.ts";
import { getBookRawText } from "../lib/book-raw-text.ts";
import { estimateTokens } from "../lib/token-estimate.ts";
import { saveNote } from "../lib/notes.ts";
import { BOOK_RAW_SYSTEM } from "../lib/ask-ai.ts";
import { appendLog } from "../lib/log.ts";

export type BookNotePayload = {
  bookId: string;
  prompt: string;
  model: string;
};

export async function bookNote(payload: BookNotePayload) {
  const { bookId, prompt, model } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new Error(`Book ${bookId} not found`);

  const createdAt = book.noteJob?.createdAt ?? new Date().toISOString();
  const setJob = (job: Partial<NoteJob>) =>
    db
      .update(books)
      .set({
        noteJob: { prompt, model, createdAt, status: "running", ...job, updatedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(books.id, bookId));

  const fail = async (error: string) => {
    await setJob({ status: "failed", error });
    await log(`AI note failed: ${error}`);
    throw new Error(error);
  };

  let def: LlmModelDef;
  try {
    def = (await resolveLlm(model)).def;
  } catch (err) {
    return fail(describeError(err));
  }

  await setJob({ status: "running" });
  await log(`Asking ${def.label} about the whole book...`);

  const raw = await getBookRawText(bookId);
  if (!raw) return fail("No raw text available for this book");

  const tokens = estimateTokens(raw.text) + estimateTokens(prompt);
  if (contextExceeded(def, tokens)) {
    return fail(
      `Raw text (~${Math.round(tokens / 1000)}k tokens) exceeds the model's context — extract chapters and ask per-chapter instead`
    );
  }
  if (def.contextAssumed && tokens > def.contextTokens) {
    await log(`~${Math.round(tokens / 1000)}k tokens against ${def.label}'s unconfirmed context — trying it rather than refusing on a guess`);
  }

  const system = BOOK_RAW_SYSTEM;
  const user = `${prompt}\n\n---\n${raw.text}`;

  let result: string;
  try {
    result = await llmChat(system, user, {
      model,
      temperature: 0.7,
      timeoutMs: 600_000,
    });
  } catch (err) {
    return fail(describeError(err));
  }

  const noteId = await saveNote({
    bookId,
    prompt,
    model,
    result,
    scope: { kind: "book-raw", files: raw.fileCount },
  });

  await setJob({ status: "done", noteId });
  await log("AI answer saved to notes");
}
