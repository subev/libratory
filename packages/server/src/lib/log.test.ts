import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../../test/setup.ts";
import { books, bookLogs } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

import { appendLog } from "./log.ts";

describe("appendLog", () => {
  beforeEach(async () => {
    await resetDb(getDb());
  });

  it("records the line against its book", async () => {
    const db = getDb();
    const bookId = crypto.randomUUID();
    await db.insert(books).values({ id: bookId, title: "Book", filename: "b.pdf", pdfPath: "/tmp/b.pdf" });

    await appendLog(bookId, "Starting PDF export");

    const rows = await db.select().from(bookLogs).where(eq(bookLogs.bookId, bookId));
    expect(rows.map((r) => r.message)).toEqual(["Starting PDF export"]);
  });

  // A job outliving its book used to take the whole startup sweep down with it
  it("stays quiet when the book was deleted mid-job", async () => {
    await expect(appendLog(crypto.randomUUID(), "Starting PDF export")).resolves.toBeUndefined();
  });

  it("still reports a failure that is not a missing book", async () => {
    await expect(appendLog("not-a-uuid", "Starting PDF export")).rejects.toThrow();
  });
});
