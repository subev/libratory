import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createUIMessageStream, pipeUIMessageStreamToResponse, readUIMessageStream, type UIMessageStreamWriter } from "ai";
import { releaseChatRun, replaceAnswer, saveAnswer, type ChatMessageMetadata, type ChatRun, type StoredChatMessage } from "./chats.ts";

// What execute spreads into toUIMessageStream, so the stream names the message it is writing:
// a fresh answer gets the id its row will have, a continuation the row it continues
export type AnswerStreamOptions = { originalMessages: StoredChatMessage[]; generateMessageId: () => string };

// Streams one answer to the browser and keeps a copy, for the library chat and the assistant panel
// alike. The run is the server's: the response is one reader of the stream, the kept copy the other,
// and the run ends when the kept copy ends — a closed tab stops the delivery, not the answer, which
// is finished and kept for whoever opens the conversation next. `execute` writes the answer; it
// returning normally, unaborted, is what "complete" means. `partialExtras` adds to an answer that
// was cut short what only a finished one would have carried (the chat's verified sources).
export async function deliverAnswer(opts: {
  request: FastifyRequest;
  reply: FastifyReply;
  conversationId: string;
  run: ChatRun;
  model: { key: string; label: string };
  execute: (writer: UIMessageStreamWriter<StoredChatMessage>, metadata: ChatMessageMetadata, fail: (err: unknown) => string, stream: AnswerStreamOptions) => Promise<void>;
  partialExtras?: (latest: StoredChatMessage) => Promise<unknown[]>;
  failedText: string;
  // The stored answer this generation continues — an approved call ran and the model goes on
  // from it — so the stream carries that message's id and the kept copy replaces its row
  continueFrom?: StoredChatMessage;
}): Promise<void> {
  const { request, reply, conversationId, run, model, continueFrom } = opts;
  // The browser, the stream and the row agree on the message's id: a card answered later has
  // to find its message again, and a continuation has to land in the one it continues
  const messageId = continueFrom?.id ?? randomUUID();
  const streamOptions: AnswerStreamOptions = { originalMessages: continueFrom ? [continueFrom] : [], generateMessageId: () => messageId };
  const metadata: ChatMessageMetadata = {
    status: "complete",
    error: null,
    modelKey: model.key,
    modelLabel: model.label,
    createdAt: new Date().toISOString(),
  };
  let completed = false;
  let failure: string | null = null;
  const fail = (err: unknown) => {
    failure = err instanceof Error ? err.message : opts.failedText;
    return failure;
  };

  const stream = createUIMessageStream<StoredChatMessage>({
    onError: fail,
    originalMessages: streamOptions.originalMessages,
    generateId: streamOptions.generateMessageId,
    execute: async ({ writer }) => {
      await opts.execute(writer, metadata, fail, streamOptions);
      if (run.controller.signal.aborted) return;
      completed = true;
    },
  });

  const [toClient, toStore] = stream.tee();
  // Taken before the stream runs: the reader continues the message in place, so the object it
  // yields is the one handed in, and comparing the two afterwards would compare a thing to itself
  const before = continueFrom ? JSON.stringify(continueFrom.parts) : null;
  const stored = (async () => {
    let latest: StoredChatMessage | undefined = continueFrom;
    try {
      for await (const message of readUIMessageStream<StoredChatMessage>({ stream: toStore, onError: fail, ...(continueFrom ? { message: continueFrom } : {}) })) {
        latest = message;
        run.latest = { ...message, id: messageId, metadata: { ...metadata, status: "streaming" } };
      }
    } catch (err) {
      fail(err);
    }
    // A stream that ended cleanly with neither words nor a tool call is not an answer: DeepSeek's
    // reasoning can spend the whole output budget and stop, and "complete" with nothing to show
    // looks like a panel that hung. Kept as failed, so the person sees the ending and a Retry. A
    // continuation starts from the message it continues, so there "nothing" means nothing changed.
    const empty = before !== null
      ? !latest || JSON.stringify(latest.parts) === before
      : !latest?.parts.some((part) => part.type === "text" || part.type === "dynamic-tool" || part.type.startsWith("tool-"));
    if (completed && empty) fail(new Error("The model answered with nothing — try again"));
    const status = completed && !empty ? "complete" : run.controller.signal.aborted ? "stopped" : "failed";
    let parts: unknown[] = latest?.parts ?? [];
    if (!completed && latest && opts.partialExtras) parts = [...parts, ...(await opts.partialExtras(latest))];
    const error = status === "failed" ? (failure ?? "The answer ended before it was finished") : null;
    if (continueFrom) await replaceAnswer({ messageId: continueFrom.id, parts, status, error });
    else await saveAnswer({ id: messageId, conversationId, parts, status, error, model: model.key, modelLabel: model.label });
  })();

  reply.hijack();
  // Not awaited: once the browser has gone, writing to its closed response never settles. The
  // kept copy always ends, so the run is released on that.
  void pipeUIMessageStreamToResponse({ response: reply.raw, stream: toClient }).catch((err: unknown) => {
    request.log.debug({ err }, "answer was not delivered");
  });
  try {
    await stored;
  } catch (err) {
    request.log.warn({ err }, "answer could not be kept");
  } finally {
    releaseChatRun(conversationId, run);
  }
}
