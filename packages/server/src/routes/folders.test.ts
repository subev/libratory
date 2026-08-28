import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, folders } from "../schema.ts";
import { eq } from "drizzle-orm";

const { mockDeleteBook } = vi.hoisted(() => ({
  mockDeleteBook: vi.fn(async (_id: string) => {}),
}));

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("../lib/delete-book.ts", () => ({
  deleteBook: mockDeleteBook,
}));

vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));

import { foldersRouter } from "./folders.ts";
import { booksRouter } from "./books.ts";

const caller = foldersRouter.createCaller({});
const booksCaller = booksRouter.createCaller({});

async function makeTree() {
  const db = getDb();
  const a = row(await db.insert(folders).values({ name: "A" }).returning());
  const b = row(await db.insert(folders).values({ name: "B", parentId: a.id }).returning());
  const c = row(await db.insert(folders).values({ name: "C", parentId: b.id }).returning());
  return { a, b, c };
}

beforeEach(async () => {
  await resetDb(getDb());
  mockDeleteBook.mockClear();
  mockDeleteBook.mockImplementation(async (id: string) => {
    await getDb().delete(books).where(eq(books.id, id));
  });
});

describe("foldersRouter CRUD", () => {
  it("creates, lists and renames folders", async () => {
    const root = await caller.create({ name: "History", parentId: null });
    const child = await caller.create({ name: "Ancient", parentId: root.id });
    expect(child.parentId).toBe(root.id);

    await caller.rename({ id: child.id, name: "Medieval" });

    const list = await caller.list();
    expect(list).toEqual([
      { id: root.id, name: "History", parentId: null },
      { id: child.id, name: "Medieval", parentId: root.id },
    ]);
  });

  it("rejects creating under a missing parent", async () => {
    await expect(caller.create({ name: "X", parentId: crypto.randomUUID() })).rejects.toThrow(
      "Parent folder not found",
    );
  });

  it("returns the ancestor path root-first", async () => {
    const { a, c } = await makeTree();
    const path = await caller.path({ id: c.id });
    expect(path.map((p) => p.name)).toEqual(["A", "B", "C"]);
    expect(path[0]?.id).toBe(a.id);
  });
});

describe("foldersRouter.move", () => {
  it("reparents a folder and allows moving to root", async () => {
    const { a, c } = await makeTree();
    await caller.move({ id: c.id, parentId: a.id });
    let path = await caller.path({ id: c.id });
    expect(path.map((p) => p.name)).toEqual(["A", "C"]);

    await caller.move({ id: c.id, parentId: null });
    path = await caller.path({ id: c.id });
    expect(path.map((p) => p.name)).toEqual(["C"]);
  });

  it("rejects moving a folder into itself or its own subtree", async () => {
    const { a, c } = await makeTree();
    await expect(caller.move({ id: a.id, parentId: a.id })).rejects.toThrow("into itself");
    await expect(caller.move({ id: a.id, parentId: c.id })).rejects.toThrow("into itself");
  });

  it("rejects a missing target", async () => {
    const { a } = await makeTree();
    await expect(caller.move({ id: a.id, parentId: crypto.randomUUID() })).rejects.toThrow(
      "Target folder not found",
    );
  });
});

describe("foldersRouter.deleteStats", () => {
  it("counts the subtree recursively", async () => {
    const db = getDb();
    const { a, b, c } = await makeTree();
    await db.insert(books).values([
      { title: "In A", folderId: a.id },
      { title: "In B", folderId: b.id },
      { title: "In C", folderId: c.id },
      { title: "Root book" },
    ]);

    expect(await caller.deleteStats({ id: a.id })).toEqual({ folderCount: 3, bookCount: 3 });
    expect(await caller.deleteStats({ id: b.id })).toEqual({ folderCount: 2, bookCount: 2 });
  });
});

describe("foldersRouter.delete", () => {
  it("deletes every descendant book through deleteBook and sweeps the folder tree", async () => {
    const db = getDb();
    const { a, c } = await makeTree();
    const other = row(await db.insert(folders).values({ name: "Other" }).returning());
    const inA = crypto.randomUUID();
    const inC = crypto.randomUUID();
    const rootBook = crypto.randomUUID();
    const inOther = crypto.randomUUID();
    await db.insert(books).values([
      { id: inA, title: "In A", folderId: a.id },
      { id: inC, title: "In C", folderId: c.id },
      { id: rootBook, title: "Root book" },
      { id: inOther, title: "In other", folderId: other.id },
    ]);

    const result = await caller.delete({ id: a.id });

    expect(result).toEqual({ deletedBooks: 2, deletedFolders: 3 });
    expect(mockDeleteBook.mock.calls.map((call) => call[0]).sort()).toEqual([inA, inC].sort());
    const remainingFolders = await db.select().from(folders);
    expect(remainingFolders.map((f) => f.id)).toEqual([other.id]);
    const remainingBooks = await db.select().from(books);
    expect(remainingBooks.map((bk) => bk.id).sort()).toEqual([rootBook, inOther].sort());
  });

  it("rejects deleting a missing folder", async () => {
    await expect(caller.delete({ id: crypto.randomUUID() })).rejects.toThrow("Folder not found");
    expect(mockDeleteBook).not.toHaveBeenCalled();
  });
});

describe("booksRouter.list folder scoping", () => {
  it("returns only direct children plus folder rows with recursive aggregates", async () => {
    const db = getDb();
    const { a, b } = await makeTree();
    await db.insert(books).values([
      { title: "Root book" },
      { title: "In A", folderId: a.id },
      { title: "In B", folderId: b.id },
    ]);

    const root = await booksCaller.list({ folderId: null });
    expect(root.books.map((bk) => bk.title)).toEqual(["Root book"]);
    expect(root.folders.map((f) => f.name)).toEqual(["A"]);
    expect(root.folders[0]?.bookCount).toBe(2);
    expect(typeof root.folders[0]?.sizeBytes).toBe("number");
    expect(root.folders[0]?.lastActivityAt).not.toBeNull();

    const insideA = await booksCaller.list({ folderId: a.id });
    expect(insideA.books.map((bk) => bk.title)).toEqual(["In A"]);
    expect(insideA.folders.map((f) => f.name)).toEqual(["B"]);
    expect(insideA.folders[0]?.bookCount).toBe(1);

    const legacy = await booksCaller.list();
    expect(legacy.books.map((bk) => bk.title)).toEqual(["Root book"]);
  });

  it("counts book-level failures but not cancellations, and flags book rows", async () => {
    const db = getDb();
    const folder = row(await db.insert(folders).values({ name: "F" }).returning());
    await db.insert(books).values([
      { title: "Broken", folderId: folder.id, status: "failed", error: "All 1 file(s) failed extraction" },
      { title: "Cancelled", folderId: folder.id, status: "failed", error: "Cancelled by user" },
      { title: "Fine", folderId: folder.id, status: "done" },
    ]);

    const root = await booksCaller.list({ folderId: null });
    expect(root.folders[0]?.failedBookCount).toBe(1);

    const inside = await booksCaller.list({ folderId: folder.id });
    const byTitle = Object.fromEntries(inside.books.map((bk) => [bk.title, bk.failed]));
    expect(byTitle).toEqual({ Broken: true, Cancelled: false, Fine: false });
  });
});

describe("booksRouter.moveToFolder", () => {
  it("moves books into a folder and back to root", async () => {
    const db = getDb();
    const { a } = await makeTree();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await db.insert(books).values([
      { id: id1, title: "One" },
      { id: id2, title: "Two" },
    ]);

    await booksCaller.moveToFolder({ ids: [id1, id2], folderId: a.id });
    let rows = await db.select().from(books);
    expect(rows.every((r) => r.folderId === a.id)).toBe(true);

    await booksCaller.moveToFolder({ ids: [id1], folderId: null });
    rows = await db.select().from(books).where(eq(books.id, id1));
    expect(rows[0]?.folderId).toBeNull();
  });

  it("rejects a nonexistent target folder", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    await db.insert(books).values({ id, title: "One" });
    await expect(booksCaller.moveToFolder({ ids: [id], folderId: crypto.randomUUID() })).rejects.toThrow(
      "Folder not found",
    );
  });
});
