import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { ReaderFor } from "./Reader.tsx";
import { containerSource, type DocumentSource } from "../lib/reader-source.ts";

// A read-along book opened from disk, with no server behind it. The same reader the library
// uses, handed a different source — which is the whole point: nothing that draws a page knows
// whether the bytes came from a route or a file someone was sent.
export function ReaderOpen() {
  const [source, setSource] = useState<DocumentSource | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => source?.close(), [source]);

  async function open(file: File) {
    setBusy(true);
    setError(null);
    try {
      const opened = await containerSource(file);
      setSource(opened);
      setName(file.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (source) {
    return (
      <div>
        <ReaderFor source={source} />
        <p className="mx-auto max-w-5xl px-4 pb-6 text-xs text-(--text-faint)" data-testid="reader-opened-file">
          Reading {name} from this device.{" "}
          <button onClick={() => setSource(null)} className="text-blue-600 hover:text-blue-800">
            Open another
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-(--bg-page) px-4 py-3">
      <div className="mx-auto max-w-2xl">
        <p className="mb-4 text-sm">
          <Link to="/" className="text-blue-600 hover:text-blue-800">← Library</Link>
        </p>
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void open(file);
          }}
          className={`rounded-lg border-2 border-dashed p-10 text-center ${
            over ? "border-blue-500 bg-blue-50/50" : "border-(--border)"
          }`}
          data-testid="reader-open-drop"
        >
          <h1 className="text-lg font-semibold text-(--text-primary)">Open a read-along EPUB</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-(--text-muted)">
            Drop a synced EPUB and read along on its own pages — the narration, the print it was
            set in, and nothing uploaded anywhere.
          </p>
          <button
            onClick={() => input.current?.click()}
            disabled={busy}
            className="mt-5 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="reader-open-pick"
          >
            {busy ? "Opening…" : "Choose a file"}
          </button>
          <input
            ref={input}
            type="file"
            accept=".epub,application/epub+zip"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; if (file) void open(file); }}
          />
          {error ? (
            <p className="mt-4 text-sm text-red-600" data-testid="reader-open-error">{error}</p>
          ) : null}
        </div>
        <p className="mt-4 text-xs text-(--text-faint)">
          It has to be a synced EPUB — the “Export synced EPUB” button on a book’s page, which puts
          the original pages and the narration timing inside the file. A plain “Export EPUB”, an M4B
          audiobook or a PDF has no pages to follow and will not open here.
        </p>
      </div>
    </div>
  );
}
