export type DragItems = { bookIds: string[]; folderIds: string[] };

const MIME = "application/x-libratory-items";

export function setDragItems(e: React.DragEvent, items: DragItems) {
  e.dataTransfer.setData(MIME, JSON.stringify(items));
  e.dataTransfer.effectAllowed = "move";
}

export function hasDragItems(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(MIME);
}

export function getDragItems(e: React.DragEvent): DragItems | null {
  try {
    const raw = e.dataTransfer.getData(MIME);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export type DroppedItems = { entries: FileSystemEntry[]; files: File[] };

// Both halves must be read synchronously: the DataTransfer is dead after the first await, so a drop
// that is going to be handled somewhere else has to be taken apart in the handler that caught it.
export function captureDrop(e: React.DragEvent): DroppedItems {
  const entries = [...e.dataTransfer.items]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  return { entries, files: [...e.dataTransfer.files] };
}

export function hasFiles(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files");
}

// Every PDF under a dropped entry, folders walked. readEntries answers in batches of at most 100,
// so a directory is read until an empty batch. Shared by the upload zone and the assistant panel.
export async function readEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return file.name.toLowerCase().endsWith(".pdf") ? [file] : [];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const entries: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      entries.push(...batch);
    }
    const nested = await Promise.all(entries.map(readEntryFiles));
    return nested.flat();
  }
  return [];
}

// The files of a drop: the plain files when nothing dropped was a folder, else every PDF found
// under the entries, in name order
export async function droppedPdfs({ entries, files }: DroppedItems): Promise<File[]> {
  if (!entries.some((entry) => entry.isDirectory)) return files;
  const collected = (await Promise.all(entries.map(readEntryFiles))).flat();
  return collected.sort((a, b) => a.name.localeCompare(b.name));
}
