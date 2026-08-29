import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, resetDb, row } from "../../test/setup.ts";
import { books, folders, profiles, DEFAULT_PROFILE_ID } from "../schema.ts";
import { eq } from "drizzle-orm";

vi.mock("../db.ts", async () => {
  const { getDb } = await import("../../test/setup.ts");
  return { get db() { return getDb(); } };
});

vi.mock("../lib/delete-book.ts", () => ({ deleteBook: vi.fn(async () => {}) }));
vi.mock("graphile-worker", () => ({ quickAddJob: vi.fn(async () => {}) }));

import { profilesRouter } from "./profiles.ts";
import { foldersRouter } from "./folders.ts";
import { booksRouter } from "./books.ts";

const caller = profilesRouter.createCaller({});

beforeEach(async () => {
  await resetDb(getDb());
});

async function makeProfile(name: string) {
  const db = getDb();
  return row(await db.insert(profiles).values({ name }).returning());
}

describe("profilesRouter CRUD", () => {
  it("lists the default profile first and marks it", async () => {
    await makeProfile("Wife");
    const list = await caller.list();
    expect(list[0]).toEqual({ id: DEFAULT_PROFILE_ID, name: "Default", isDefault: true, books: 0, folders: 0 });
    expect(list[1]).toMatchObject({ name: "Wife", isDefault: false });
  });

  it("creates and renames profiles", async () => {
    const created = await caller.create({ name: "Kids" });
    await caller.rename({ id: created.id, name: "Family" });
    const list = await caller.list();
    expect(list.map((p) => p.name)).toEqual(["Default", "Family"]);
  });

  it("refuses to delete the default profile", async () => {
    await expect(caller.delete({ id: DEFAULT_PROFILE_ID })).rejects.toThrow(
      "Cannot delete the default profile",
    );
  });

  it("refuses to delete a profile that still has content", async () => {
    const profile = await makeProfile("Wife");
    await getDb().insert(books).values({ title: "Hers", profileId: profile.id });
    await expect(caller.delete({ id: profile.id })).rejects.toThrow(
      "Profile still has books or folders",
    );
  });

  it("counts the books and folders each profile holds", async () => {
    const db = getDb();
    const profile = await makeProfile("Wife");
    await db.insert(books).values({ title: "Hers", profileId: profile.id });
    await db.insert(books).values({ title: "Also hers", profileId: profile.id });
    await db.insert(folders).values({ name: "Hers", profileId: profile.id });
    await db.insert(books).values({ title: "Mine" });

    const list = await caller.list();
    expect(list).toMatchObject([
      { name: "Default", books: 1, folders: 0 },
      { name: "Wife", books: 2, folders: 1 },
    ]);
  });

  it("deletes an empty profile", async () => {
    const profile = await makeProfile("Temp");
    await caller.delete({ id: profile.id });
    const list = await caller.list();
    expect(list.map((p) => p.name)).toEqual(["Default"]);
  });
});

describe("profile scoping", () => {
  it("scopes folders.list and books.list to the caller's profile", async () => {
    const db = getDb();
    const other = await makeProfile("Wife");
    const mine = row(await db.insert(folders).values({ name: "Mine" }).returning());
    const hers = row(await db.insert(folders).values({ name: "Hers", profileId: other.id }).returning());
    await db.insert(books).values({ title: "My book" });
    await db.insert(books).values({ title: "Her book", profileId: other.id });

    const defaultFolders = await foldersRouter.createCaller({}).list();
    expect(defaultFolders.map((f) => f.id)).toEqual([mine.id]);

    const herList = await booksRouter.createCaller({ profileId: other.id }).list({ folderId: null });
    expect(herList.books.map((b) => b.title)).toEqual(["Her book"]);
    expect(herList.folders.map((f) => f.id)).toEqual([hers.id]);
  });

  it("hides another profile's folder from path/rename/move/delete", async () => {
    const db = getDb();
    const other = await makeProfile("Wife");
    const hers = row(await db.insert(folders).values({ name: "Hers", profileId: other.id }).returning());

    const defaultCaller = foldersRouter.createCaller({});
    await expect(defaultCaller.path({ id: hers.id })).rejects.toThrow("Folder not found");
    await expect(defaultCaller.move({ id: hers.id, parentId: null })).rejects.toThrow("Folder not found");
    await expect(defaultCaller.delete({ id: hers.id })).rejects.toThrow("Folder not found");
    await expect(
      defaultCaller.create({ name: "Sub", parentId: hers.id }),
    ).rejects.toThrow("Parent folder not found");

    await defaultCaller.rename({ id: hers.id, name: "Stolen" });
    const unchanged = row(await db.select().from(folders).where(eq(folders.id, hers.id)));
    expect(unchanged.name).toBe("Hers");
  });

  it("refuses to move books into another profile's folder and skips foreign books", async () => {
    const db = getDb();
    const other = await makeProfile("Wife");
    const hers = row(await db.insert(folders).values({ name: "Hers", profileId: other.id }).returning());
    const herBook = row(await db.insert(books).values({ title: "Her book", profileId: other.id }).returning());
    const myFolder = row(await db.insert(folders).values({ name: "Mine" }).returning());

    const defaultCaller = booksRouter.createCaller({});
    await expect(
      defaultCaller.moveToFolder({ ids: [herBook.id], folderId: hers.id }),
    ).rejects.toThrow("Folder not found");

    await defaultCaller.moveToFolder({ ids: [herBook.id], folderId: myFolder.id });
    const after = row(await db.select().from(books).where(eq(books.id, herBook.id)));
    expect(after.folderId).toBeNull();
  });
});
