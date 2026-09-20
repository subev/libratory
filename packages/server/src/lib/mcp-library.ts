import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.ts";
import { books, folders, profiles } from "../schema.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An agent knows a profile or a folder by the name a person gave it, not by a uuid it was never
// shown — so every MCP argument that places something takes either.
export async function resolveProfileId(nameOrId: string): Promise<string> {
  const all = await db.select({ id: profiles.id, name: profiles.name }).from(profiles).orderBy(asc(profiles.createdAt));
  const wanted = nameOrId.trim().toLowerCase();
  const match = all.find((p) => p.id === wanted) ?? all.find((p) => p.name.toLowerCase() === wanted);
  if (!match) throw new Error(`No profile "${nameOrId}" — the profiles are: ${all.map((p) => p.name).join(", ")}`);
  return match.id;
}

export type FolderEntry = { id: string; name: string; path: string; parentId: string | null; books: number };

export async function listFolderPaths(profileId: string): Promise<FolderEntry[]> {
  const rows = await db
    .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.profileId, profileId))
    .orderBy(asc(folders.name));
  const counts = await db
    .select({ folderId: books.folderId, count: sql<number>`count(*)::int` })
    .from(books)
    .where(eq(books.profileId, profileId))
    .groupBy(books.folderId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string): string => {
    const names: string[] = [];
    // Bounded by the row count, so a parent cycle in the data cannot hang a tool call.
    for (let at = byId.get(id), hops = 0; at && hops <= rows.length; at = at.parentId ? byId.get(at.parentId) : undefined, hops++) {
      names.unshift(at.name);
    }
    return names.join("/");
  };
  return rows
    .map((r) => ({ ...r, path: pathOf(r.id), books: counts.find((c) => c.folderId === r.id)?.count ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// `folder` is an id or a path of names from the top level ("Work/Contracts"). A path that does
// not exist is created only where the caller is placing a book; a filter must not create.
export async function resolveFolderId(profileId: string, folder: string, options: { create: boolean }): Promise<string> {
  if (UUID_RE.test(folder.trim())) {
    const [owned] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folder.trim()), eq(folders.profileId, profileId)));
    if (!owned) throw new Error(`No folder with id ${folder} in this profile`);
    return owned.id;
  }
  const names = folder.split("/").map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) throw new Error("Empty folder name");
  let parentId: string | null = null;
  for (const name of names) {
    const siblings: { id: string; name: string }[] = await db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(and(eq(folders.profileId, profileId), parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId)));
    const existing = siblings.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      parentId = existing.id;
      continue;
    }
    if (!options.create) {
      const known = (await listFolderPaths(profileId)).map((f) => f.path);
      throw new Error(`No folder "${folder}" — ${known.length > 0 ? `the folders are: ${known.join(", ")}` : "this profile has no folders"}`);
    }
    const inserted: { id: string }[] = await db.insert(folders).values({ name: name.slice(0, 200), parentId, profileId }).returning({ id: folders.id });
    const created = inserted[0];
    if (!created) throw new Error(`Could not create the folder "${name}"`);
    parentId = created.id;
  }
  if (parentId === null) throw new Error("Empty folder name");
  return parentId;
}

export async function listProfiles(currentId: string) {
  const all = await db.select({ id: profiles.id, name: profiles.name }).from(profiles).orderBy(asc(profiles.createdAt));
  return all.map((p) => ({ ...p, current: p.id === currentId }));
}
