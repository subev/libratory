import { useEffect, useRef, useState } from "react";
import { isPdf, removeStagedUpload, uploadStaged } from "../../lib/staged-upload.ts";
import { formatBytes } from "../../lib/format.ts";
import { Button } from "../Button.tsx";
import { PillToggle } from "../PillToggle.tsx";
import { IconChevronDown, IconChevronUp, IconClose, IconDocument, IconFailed, IconSpinner } from "../icons.tsx";

// What several dropped files are meant to become. Sent as a sentence in the message, so the model
// never has to ask and never guesses.
export type Bundle = "one" | "each";

export function bundleSentence(bundle: Bundle, count: number): string {
  return bundle === "one" ? `Make one book from these ${count} files, in this order.` : `Make a separate book from each of these ${count} files.`;
}

export type Chip = {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  progress: number;
  id?: string;
  ref?: string;
  error?: string;
  abort?: () => void;
};

// The composer's attachments: one chip per dropped file, from the first byte to the send. The
// state lives here so the thread only needs the references of the ready ones.
export function useStagedChips() {
  const [chips, setChips] = useState<Chip[]>([]);
  const update = (key: string, patch: Partial<Chip>) => setChips((all) => all.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  // The thread remounts on every switch and new chat; an upload still running then would land a
  // file no thread ever claims. Aborted, the server discards it as an interrupted upload.
  const inFlight = useRef(new Map<string, () => void>());
  useEffect(() => {
    const aborts = inFlight.current;
    return () => {
      for (const abort of aborts.values()) abort();
      aborts.clear();
    };
  }, []);

  const add = (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      if (!isPdf(file)) {
        setChips((all) => [...all, { key, name: file.name, size: file.size, status: "failed", progress: 0, error: "Not a PDF" }]);
        continue;
      }
      const { done, abort } = uploadStaged(file, (fraction) => update(key, { progress: fraction }));
      inFlight.current.set(key, abort);
      setChips((all) => [...all, { key, name: file.name, size: file.size, status: "uploading", progress: 0, abort }]);
      done
        .then((staged) => update(key, { status: "ready", progress: 1, id: staged.id, ref: staged.ref, abort: undefined }))
        .catch((err: unknown) => update(key, { status: "failed", error: err instanceof Error ? err.message : "Upload failed", abort: undefined }))
        .finally(() => inFlight.current.delete(key));
    }
  };

  const remove = (key: string) => {
    const chip = chips.find((c) => c.key === key);
    chip?.abort?.();
    inFlight.current.delete(key);
    if (chip?.id) void removeStagedUpload(chip.id);
    setChips((all) => all.filter((c) => c.key !== key));
  };

  const clear = () => setChips([]);

  // Up or down one place: the order is the order the files make a book in
  const move = (key: string, by: -1 | 1) =>
    setChips((all) => {
      const index = all.findIndex((c) => c.key === key);
      const target = index + by;
      if (index < 0 || target < 0 || target >= all.length) return all;
      const next = [...all];
      const [chip] = next.splice(index, 1);
      if (chip) next.splice(target, 0, chip);
      return next;
    });

  return { chips, add, remove, move, clear, uploading: chips.some((c) => c.status === "uploading"), refs: chips.flatMap((c) => (c.ref ? [c.ref] : [])) };
}

export function BundleChoice({ value, onChange, count }: { value: Bundle; onChange: (bundle: Bundle) => void; count: number }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-(--text-muted)" data-testid="assistant-bundle">
      <span>{count} files:</span>
      <PillToggle selected={value === "one"} onClick={() => onChange("one")} testId="assistant-bundle-one">One book, in this order</PillToggle>
      <PillToggle selected={value === "each"} onClick={() => onChange("each")} testId="assistant-bundle-each">A book each</PillToggle>
    </div>
  );
}

export function StagedChips({ chips, onRemove, onMove }: { chips: Chip[]; onRemove: (key: string) => void; onMove: (key: string, by: -1 | 1) => void }) {
  if (chips.length === 0) return null;
  const ordered = chips.length > 1;
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5" data-testid="assistant-chips">
      {chips.map((chip, index) => (
        <li
          key={chip.key}
          title={chip.error ?? `${chip.name} · ${formatBytes(chip.size)}`}
          className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs ${
            chip.status === "failed" ? "border-(--danger) text-(--danger-text)" : "border-(--border) bg-(--bg-card) text-(--text-primary)"
          }`}
          data-testid={`assistant-chip-${chip.status}`}
        >
          {chip.status === "uploading" ? <IconSpinner className="h-3 w-3 shrink-0 animate-spin" /> : chip.status === "failed" ? <IconFailed className="h-3 w-3 shrink-0" /> : <IconDocument className="h-3 w-3 shrink-0 text-(--text-muted)" />}
          <span className="truncate">{chip.name}</span>
          <span className="shrink-0 text-(--text-faint)">
            {chip.status === "uploading" ? `${Math.round(chip.progress * 100)}%` : chip.status === "failed" ? chip.error : formatBytes(chip.size)}
          </span>
          {ordered && (
            <>
              <Button variant="icon" size="sm" onClick={() => onMove(chip.key, -1)} disabled={index === 0} aria-label={`Move ${chip.name} up`} className="-mr-1">
                <IconChevronUp className="h-3 w-3" />
              </Button>
              <Button variant="icon" size="sm" onClick={() => onMove(chip.key, 1)} disabled={index === chips.length - 1} aria-label={`Move ${chip.name} down`} className="-mr-1">
                <IconChevronDown className="h-3 w-3" />
              </Button>
            </>
          )}
          <Button variant="icon" size="sm" onClick={() => onRemove(chip.key)} aria-label={`Remove ${chip.name}`} className="-mr-1">
            <IconClose className="h-3 w-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
