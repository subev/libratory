import type { ReactNode } from "react";
import { Link } from "react-router";
import type { OcrEngine } from "../lib/ocr.ts";

// The one description of the two engines, shown wherever a scan is about to be read
export function OcrEngineChoice({ value, onChange, note, tryHref }: { value: OcrEngine | null; onChange: (engine: OcrEngine) => void; note?: ReactNode; tryHref?: string }) {
  return (
    <div className="space-y-1.5 text-xs text-(--text-muted)" data-testid="book-ocr-engine">
      <span className="block text-(--text-secondary)">Scanned pages</span>
      <span className="block">
        The pages are images. One engine reads them once into a searchable copy kept beside the original, which
        is never replaced; every extraction, search and export afterwards reads that copy.
      </span>
      {([
        ["tesseract", "Tesseract", "about a second a page; read-along word by word"],
        ["surya", "Surya", "roughly ten times slower; better on photographed, curled, faded or skewed pages; read-along word by word at estimated positions, a character or so off at worst"],
      ] as const).map(([engine, name, trade]) => (
        <label key={engine} className="flex gap-2">
          <input
            type="radio"
            name="ocr-engine"
            checked={(value ?? "tesseract") === engine}
            onChange={() => onChange(engine)}
            className="mt-0.5"
            data-testid={`book-ocr-engine-${engine}`}
          />
          <span><span className="text-(--text-secondary)">{name}</span>{value === null && engine === "tesseract" ? " (suggested)" : ""} — {trade}</span>
        </label>
      ))}
      {note && <span className="block" data-testid="book-ocr-suggestion">{note}</span>}
      <span className="block">
        {tryHref ? (
          <><Link to={tryHref} className="text-(--accent-text) hover:text-(--accent-text-hover)" data-testid="book-ocr-try">Try one page…</Link>{" "}— see both engines on a page you pick, with the image beside them, before committing 300 pages to one.</>
        ) : (
          <>Try one page — both engines on a page you pick, with the image beside them — is on the book page once the upload lands.</>
        )}
      </span>
    </div>
  );
}
