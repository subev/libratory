import { eq } from "drizzle-orm";
import type { TaskSpec } from "graphile-worker";

import { db } from "../db.ts";
import { books } from "../schema.ts";
import { parseTtsVoice } from "./tts.ts";

// graphile runs the jobs of one named queue strictly one at a time, and a worker walks past a
// queue that is busy to the next job it can run.
export const MLX_QUEUE = "tts-mlx";

// The MLX narrators share one model and `runExclusiveMlxSynthesis` lets one of them speak at a
// time. Unnamed, a second such job took a pool slot only to wait on that lock — and the queue is
// first-in-first-out, so a Bulgarian book with chapters to go held every slot while a Kokoro book
// queued behind it sat at "pending" with nothing running. The lock stays as the backstop: a voice
// changed after its jobs were queued leaves their queue name stale, which costs a slot, not a clash.
export function synthesisQueueName(voice: string): string | undefined {
  try {
    const { engine } = parseTtsVoice(voice);
    return engine === "bg-mlx" || engine === "kugel" ? MLX_QUEUE : undefined;
  } catch {
    // The worker reports an unknown voice, by name, on the chapter it fails
    return undefined;
  }
}

// `variantKey` picks the lane's own voice where it has one, as the variant worker will
export async function synthesisJobSpec(bookId: string, variantKey?: string): Promise<TaskSpec> {
  const [book] = await db
    .select({ voice: books.voice, variantVoices: books.variantVoices })
    .from(books)
    .where(eq(books.id, bookId));
  const voice = (variantKey ? book?.variantVoices?.[variantKey]?.voice : undefined) ?? book?.voice;
  const queueName = voice ? synthesisQueueName(voice) : undefined;
  return { maxAttempts: 1, ...(queueName ? { queueName } : {}) };
}
