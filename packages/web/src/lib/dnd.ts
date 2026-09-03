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
