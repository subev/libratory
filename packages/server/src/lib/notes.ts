import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { books, notes, DEFAULT_PROFILE_ID, type NoteScope } from "../schema.ts";

export async function saveNote(input: {
  bookId: string | null;
  profileId?: string;
  prompt: string;
  model: string;
  result: string;
  scope: NoteScope;
}): Promise<string> {
  let profileId = input.profileId;
  if (!profileId && input.bookId) {
    const [book] = await db.select({ profileId: books.profileId }).from(books).where(eq(books.id, input.bookId));
    profileId = book?.profileId;
  }
  const [note] = await db
    .insert(notes)
    .values({ ...input, profileId: profileId ?? DEFAULT_PROFILE_ID })
    .returning({ id: notes.id });
  if (!note) throw new Error("Failed to save note");
  return note.id;
}
