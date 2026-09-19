import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, DEFAULT_PROFILE_ID } from "../schema.ts";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { MLX_QUEUE, synthesisJobSpec, synthesisQueueName } from "./synthesis-jobs.ts";

describe("synthesisQueueName", () => {
  it("puts the narrators that share one model in one queue", () => {
    expect(synthesisQueueName("bg-mlx:narrator")).toBe(MLX_QUEUE);
    expect(synthesisQueueName("kugel:default")).toBe(MLX_QUEUE);
  });

  it("leaves every other engine free to take any slot", () => {
    expect(synthesisQueueName("af_heart")).toBeUndefined();
    expect(synthesisQueueName("say:samantha")).toBeUndefined();
    expect(synthesisQueueName("bg-mms:bul")).toBeUndefined();
  });

  it("leaves a voice it cannot read for the worker to report", () => {
    expect(synthesisQueueName("bg-mlx:nobody")).toBeUndefined();
  });
});

describe("synthesisJobSpec", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  async function book(values: Partial<typeof books.$inferInsert>) {
    const [row] = await getDb().insert(books).values({ title: "A book", kind: "api", profileId: DEFAULT_PROFILE_ID, ...values }).returning();
    if (!row) throw new Error("no book");
    return row.id;
  }

  it("fails once and names the queue from the book's voice", async () => {
    expect(await synthesisJobSpec(await book({ voice: "bg-mlx:narrator" }))).toEqual({ maxAttempts: 1, queueName: MLX_QUEUE });
    expect(await synthesisJobSpec(await book({ voice: "af_heart" }))).toEqual({ maxAttempts: 1 });
  });

  it("follows a variant lane's own voice, and the book's where the lane has none", async () => {
    const id = await book({ voice: "af_heart", variantVoices: { Bulgarian: { voice: "bg-mlx:narrator" } } });
    expect(await synthesisJobSpec(id, "Bulgarian")).toEqual({ maxAttempts: 1, queueName: MLX_QUEUE });
    expect(await synthesisJobSpec(id, "French")).toEqual({ maxAttempts: 1 });
  });
});
