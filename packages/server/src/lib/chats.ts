import { and, asc, desc, eq, gt, inArray, lt, max, ne, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { db } from "../db.ts";
import { books, chatConversations, chatMessages, folders, type ChatBookRef, type ChatScope } from "../schema.ts";
import { CitationCatalog, type ChatSearchScope, type CitationSource } from "./chat-tools.ts";
import { removeStagedForConversation } from "./staged-files.ts";

export type ChatMessageStatus = (typeof chatMessages.$inferSelect)["status"];

export type ChatMessageMetadata = {
  // "streaming" never reaches the table: it is an answer still being written, read out of the run
  status: ChatMessageStatus | "streaming";
  error: string | null;
  modelKey: string | null;
  modelLabel: string | null;
  createdAt: string;
};

export type StoredChatMessage = UIMessage<ChatMessageMetadata>;

// What crosses tRPC. The parts are the SDK's own and its type is too deep to serialise through
// the router, so they travel opaque and the web side names them once, where it hands them to useChat.
export type WireChatMessage = { id: string; role: "user" | "assistant"; parts: unknown[]; metadata: ChatMessageMetadata };

export type ResolvedChatScope =
  | { kind: "screen" }
  | { kind: "library" }
  | { kind: "folder"; folderId: string; name: string; available: boolean }
  | { kind: "books"; books: (ChatBookRef & { available: boolean })[] };

const TITLE_CHARS = 80;

// The first question names the conversation — no model call for a title
export function titleFromQuestion(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_CHARS) return flat;
  const cut = flat.slice(0, TITLE_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), TITLE_CHARS / 2))}…`;
}

// Generations in flight, by conversation. The run is the server's: it goes on when the tab that
// asked is closed, and ends only by finishing, by Stop, or by the conversation being deleted. In
// memory like the extract registry — a restart ends the run with the process, and the question it
// was answering is already saved.
export type ChatRun = {
  controller: AbortController;
  // The answer as far as it has got, for a window that opens while it is being written
  latest: StoredChatMessage | null;
  ended: Promise<void>;
  end: () => void;
};

const running = new Map<string, ChatRun>();

export const STOPPED_BY_DELETE = "conversation deleted";

export function isChatRunning(conversationId: string): boolean {
  return running.has(conversationId);
}

export function liveAnswer(conversationId: string): StoredChatMessage | null {
  return running.get(conversationId)?.latest ?? null;
}

// Null when the conversation is already answering — one generation at a time
export function claimChatRun(conversationId: string): ChatRun | null {
  if (running.has(conversationId)) return null;
  let end = () => {};
  const ended = new Promise<void>((resolve) => { end = resolve; });
  const run: ChatRun = { controller: new AbortController(), latest: null, ended, end };
  running.set(conversationId, run);
  return run;
}

export function releaseChatRun(conversationId: string, run: ChatRun) {
  if (running.get(conversationId) === run) running.delete(conversationId);
  run.end();
}

// Resolves once the run has wound down and its answer is kept, so whatever comes next — asking
// again, most of all — never meets a run that is still letting go
export async function stopChatRun(conversationId: string, reason = "stopped"): Promise<boolean> {
  const run = running.get(conversationId);
  if (!run) return false;
  run.controller.abort(reason);
  await run.ended;
  return true;
}

export async function getConversation(profileId: string, id: string) {
  const [row] = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.profileId, profileId)));
  return row ?? null;
}

async function existingBooks(profileId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(and(eq(books.profileId, profileId), inArray(books.id, ids)));
  return new Map(rows.map((row) => [row.id, row.title]));
}

// The scope as it stands today: current titles where the book is still there, the snapshot where
// it is not
export async function resolveScope(profileId: string, scope: ChatScope): Promise<ResolvedChatScope> {
  switch (scope.kind) {
    case "screen":
    case "library":
      return scope;
    case "folder": {
      const [folder] = await db
        .select({ name: folders.name })
        .from(folders)
        .where(and(eq(folders.id, scope.folderId), eq(folders.profileId, profileId)));
      return { ...scope, name: folder?.name ?? scope.name, available: !!folder };
    }
    case "books": {
      const present = await existingBooks(profileId, scope.books.map((book) => book.id));
      return {
        kind: "books",
        books: scope.books.map((book) => ({ id: book.id, title: present.get(book.id) ?? book.title, available: present.has(book.id) })),
      };
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

// What the tools may search right now, or null when nothing the conversation chose is left.
// A missing scope is never widened into a whole-library search.
export function searchScopeOf(profileId: string, scope: ResolvedChatScope, screenBookId?: string): ChatSearchScope | null {
  switch (scope.kind) {
    // The page decides: the book on screen, else everything
    case "screen":
      return screenBookId ? { profileId, bookIds: [screenBookId] } : { profileId };
    case "library":
      return { profileId };
    case "folder":
      return scope.available ? { profileId, folderId: scope.folderId } : null;
    case "books": {
      const bookIds = scope.books.filter((book) => book.available).map((book) => book.id);
      return bookIds.length > 0 ? { profileId, bookIds } : null;
    }
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

// Validates a requested scope against the profile and snapshots the names it will be shown by
export async function scopeFromInput(
  profileId: string,
  input: { kind: "screen" } | { kind: "library" } | { kind: "folder"; folderId: string } | { kind: "books"; bookIds: string[] },
): Promise<ChatScope> {
  switch (input.kind) {
    case "screen":
      return { kind: "screen" };
    case "library":
      return { kind: "library" };
    case "folder": {
      const [folder] = await db
        .select({ name: folders.name })
        .from(folders)
        .where(and(eq(folders.id, input.folderId), eq(folders.profileId, profileId)));
      if (!folder) throw new Error("Folder not found");
      return { kind: "folder", folderId: input.folderId, name: folder.name };
    }
    case "books": {
      const present = await existingBooks(profileId, input.bookIds);
      const chosen = [...new Set(input.bookIds)].flatMap((id) => {
        const title = present.get(id);
        return title === undefined ? [] : [{ id, title }];
      });
      if (chosen.length === 0) throw new Error("Pick at least one book");
      return { kind: "books", books: chosen };
    }
    default: {
      const unhandled: never = input;
      throw new Error(`unhandled chat scope ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function createConversation(profileId: string, scope: ChatScope, model: string | null): Promise<string> {
  // Conversations whose first question never landed are invisible; a day is long enough to be sure
  await db.delete(chatConversations).where(and(
    eq(chatConversations.profileId, profileId),
    eq(chatConversations.title, ""),
    lt(chatConversations.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  ));
  const [row] = await db.insert(chatConversations).values({ profileId, scope, model }).returning({ id: chatConversations.id });
  if (!row) throw new Error("Could not start the conversation");
  return row.id;
}

export async function listConversations(profileId: string) {
  const rows = await db
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      scope: chatConversations.scope,
      citedBooks: chatConversations.citedBooks,
      updatedAt: chatConversations.updatedAt,
      // Spelled out: drizzle renders the column bare, and a bare "id" in here is the message's own
      answers: sql<number>`(SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id = "chat_conversations"."id" AND m.role = 'assistant')`,
    })
    .from(chatConversations)
    // Untitled means never asked: a first question that was refused leaves one behind
    .where(and(eq(chatConversations.profileId, profileId), ne(chatConversations.title, "")))
    .orderBy(desc(chatConversations.updatedAt));

  // Every question asked, so history can be searched by more than the first one
  const asked = rows.length === 0 ? [] : await db
    .select({ conversationId: chatMessages.conversationId, parts: chatMessages.parts })
    .from(chatMessages)
    .where(and(eq(chatMessages.role, "user"), inArray(chatMessages.conversationId, rows.map((row) => row.id))))
    .orderBy(asc(chatMessages.seq));
  const questions = new Map<string, string[]>();
  for (const message of asked) {
    const text = message.parts.flatMap((part) => {
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    }).join(" ");
    questions.set(message.conversationId, [...(questions.get(message.conversationId) ?? []), text]);
  }

  const referenced = rows.flatMap((row) => [
    ...(row.scope.kind === "books" ? row.scope.books.map((book) => book.id) : []),
    ...row.citedBooks.map((book) => book.id),
  ]);
  const present = await existingBooks(profileId, [...new Set(referenced)]);
  const current = (book: ChatBookRef) => ({ id: book.id, title: present.get(book.id) ?? book.title, available: present.has(book.id) });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt,
    answers: row.answers,
    questions: questions.get(row.id) ?? [],
    scope: row.scope.kind === "books" ? { kind: "books" as const, books: row.scope.books.map(current) } : row.scope,
    citedBooks: row.citedBooks.map(current),
  }));
}

function toUiMessage(row: typeof chatMessages.$inferSelect): StoredChatMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts as StoredChatMessage["parts"],
    metadata: {
      status: row.status,
      error: row.error,
      modelKey: row.model,
      modelLabel: row.modelLabel,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export async function loadMessages(conversationId: string): Promise<StoredChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.seq));
  return rows.map(toUiMessage);
}

// What the model is shown of the history. An answer that was cut short keeps its words and loses
// its tool calls: a call without its result is not a valid turn to replay.
export function messagesForModel(history: StoredChatMessage[]): UIMessage[] {
  return history.flatMap((message) => {
    if (message.role !== "assistant" || message.metadata?.status === "complete") return [message];
    const text = message.parts.filter((part) => part.type === "text");
    return text.length > 0 ? [{ ...message, parts: text }] : [];
  });
}

async function nextSeq(conversationId: string): Promise<number> {
  const [tail] = await db
    .select({ seq: max(chatMessages.seq) })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId));
  return (tail?.seq ?? -1) + 1;
}

// Saved before any generation starts, so a question survives whatever happens to its answer
export async function appendQuestion(conversation: { id: string; title: string }, text: string, model: string) {
  await db.insert(chatMessages).values({
    conversationId: conversation.id,
    seq: await nextSeq(conversation.id),
    role: "user",
    parts: [{ type: "text", text }],
  });
  await db
    .update(chatConversations)
    .set({ model, updatedAt: new Date(), ...(conversation.title ? {} : { title: titleFromQuestion(text) }) })
    .where(eq(chatConversations.id, conversation.id));
}

// "Ask again", addressed to the question by its place in the conversation — the page's count of
// questions up to and including the one being retried. A question refused before it was saved
// (no model, no tools, already answering) exists only in the page: it is one past what is stored
// and is saved now, as the submission it never got to be. One that was saved has whatever
// followed it dropped. Without the ordinal a refused second question regenerated the *first* —
// deleting its answer and filing the new one under the wrong question.
export type RetryOutcome = "regenerated" | "submitted" | "out-of-step" | "nothing-to-ask";

export async function retryQuestion(
  conversation: { id: string; title: string },
  opts: { ordinal: number | undefined; text: string; model: string },
): Promise<RetryOutcome> {
  const questions = await db
    .select({ seq: chatMessages.seq })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversation.id), eq(chatMessages.role, "user")))
    .orderBy(desc(chatMessages.seq));
  const ordinal = opts.ordinal ?? questions.length;

  if (ordinal === questions.length + 1) {
    if (!opts.text) return "nothing-to-ask";
    await appendQuestion(conversation, opts.text, opts.model);
    return "submitted";
  }
  const [last] = questions;
  if (ordinal !== questions.length || !last) return questions.length === 0 ? "nothing-to-ask" : "out-of-step";

  await db.delete(chatMessages).where(and(eq(chatMessages.conversationId, conversation.id), gt(chatMessages.seq, last.seq)));
  await db.update(chatConversations).set({ model: opts.model, updatedAt: new Date() }).where(eq(chatConversations.id, conversation.id));
  return "regenerated";
}

// The chat's citation discipline: passages the search returned are the only ids an answer may
// cite, seeded from earlier answers so a follow-up can point back at them
export function seedCatalog(history: { parts: unknown[] }[]): CitationCatalog {
  const catalog = new CitationCatalog();
  for (const message of history) catalog.seed(sourcesOf(message.parts));
  return catalog;
}

export function sourcesOf(parts: unknown[]): CitationSource[] {
  return parts.flatMap((part) => {
    const candidate = part as { type?: unknown; data?: unknown };
    return candidate.type === "data-sources" && Array.isArray(candidate.data) ? (candidate.data as CitationSource[]) : [];
  });
}

// Books the transcript points into that are no longer in the library — cited ones as well as
// chosen ones, because a whole-library chat cites books it never listed as sources
export async function removedBookIds(profileId: string, scope: ResolvedChatScope, messages: StoredChatMessage[]): Promise<string[]> {
  const referenced = new Set<string>(scope.kind === "books" ? scope.books.map((book) => book.id) : []);
  for (const message of messages) for (const source of sourcesOf(message.parts)) referenced.add(source.bookId);
  const present = await existingBooks(profileId, [...referenced]);
  return [...referenced].filter((id) => !present.has(id));
}

// Writes the answer as it ended. The conversation is looked up first: one deleted mid-answer must
// stay deleted, and its late answer has nowhere to go.
// A tool part as the SDK stores it, read loosely: the parts are jsonb and only the fields the
// approval flow touches are named here
export type ToolPartLike = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  approval?: { id: string; approved?: boolean; reason?: string };
};

const isToolPartLike = (part: unknown): part is ToolPartLike =>
  !!part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string" && (part as ToolPartLike).type.startsWith("tool-") || (part as ToolPartLike)?.type === "dynamic-tool";

// The panel's Run or Cancel, written into the stored message: the call's state goes from
// approval-requested to approval-responded, and the next generation executes or denies it.
// Null when no such request is waiting — a stale card, or one already answered.
export function respondToApproval(history: StoredChatMessage[], approvalId: string, approved: boolean, reason?: string): StoredChatMessage | null {
  const message = history.at(-1);
  if (!message || message.role !== "assistant") return null;
  let found = false;
  const parts = message.parts.map((part) => {
    if (!isToolPartLike(part) || part.state !== "approval-requested" || part.approval?.id !== approvalId) return part;
    found = true;
    return { ...part, state: "approval-responded", approval: { ...part.approval, approved, ...(reason ? { reason } : {}) } };
  });
  return found ? { ...message, parts: parts as StoredChatMessage["parts"] } : null;
}

// A card the person walked past — asked something else instead of Run or Cancel — is answered
// no on their behalf, so the call is never left dangling in front of the model
export function denyPendingApprovals(message: StoredChatMessage, reason: string): StoredChatMessage | null {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (!isToolPartLike(part) || part.state !== "approval-requested" || !part.approval) return part;
    changed = true;
    return { ...part, state: "approval-responded", approval: { ...part.approval, approved: false, reason } };
  });
  return changed ? { ...message, parts: parts as StoredChatMessage["parts"] } : null;
}

export async function updateMessageParts(messageId: string, parts: unknown[]): Promise<void> {
  await db.update(chatMessages).set({ parts }).where(eq(chatMessages.id, messageId));
}

// An answer continued in place — after an approved call ran — replaces its own row
export async function replaceAnswer(opts: { messageId: string; parts: unknown[]; status: ChatMessageStatus; error: string | null }): Promise<void> {
  await db.update(chatMessages).set({ parts: opts.parts, status: opts.status, error: opts.error }).where(eq(chatMessages.id, opts.messageId));
  const [row] = await db.select({ conversationId: chatMessages.conversationId }).from(chatMessages).where(eq(chatMessages.id, opts.messageId));
  if (row) await db.update(chatConversations).set({ updatedAt: new Date() }).where(eq(chatConversations.id, row.conversationId));
}

export async function saveAnswer(opts: {
  // The id the stream carried, so the row and the message the browser holds are one
  id?: string;
  conversationId: string;
  parts: unknown[];
  status: ChatMessageStatus;
  error: string | null;
  model: string;
  modelLabel: string;
}) {
  const [conversation] = await db
    .select({ citedBooks: chatConversations.citedBooks })
    .from(chatConversations)
    .where(eq(chatConversations.id, opts.conversationId));
  if (!conversation) return;

  await db.insert(chatMessages).values({
    ...(opts.id ? { id: opts.id } : {}),
    conversationId: opts.conversationId,
    seq: await nextSeq(opts.conversationId),
    role: "assistant",
    parts: opts.parts,
    status: opts.status,
    error: opts.error,
    model: opts.model,
    modelLabel: opts.modelLabel,
  });

  const cited = new Map(conversation.citedBooks.map((book) => [book.id, book]));
  for (const source of sourcesOf(opts.parts)) cited.set(source.bookId, { id: source.bookId, title: source.bookTitle });
  await db
    .update(chatConversations)
    .set({ citedBooks: [...cited.values()], updatedAt: new Date() })
    .where(eq(chatConversations.id, opts.conversationId));
}

export async function deleteConversation(profileId: string, id: string): Promise<boolean> {
  // Ownership first: the run registry is keyed by conversation alone, and a delete from another
  // profile used to stop the owner's answer before failing to find the row
  if (!(await getConversation(profileId, id))) return false;
  // Aborted, not awaited: saveAnswer looks the conversation up first, so an answer that ends after
  // the row has gone has nowhere to land
  running.get(id)?.controller.abort(STOPPED_BY_DELETE);
  await removeStagedForConversation(id);
  const deleted = await db
    .delete(chatConversations)
    .where(and(eq(chatConversations.id, id), eq(chatConversations.profileId, profileId)))
    .returning({ id: chatConversations.id });
  return deleted.length > 0;
}
