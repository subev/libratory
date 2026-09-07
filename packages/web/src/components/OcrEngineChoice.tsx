import type { ReactNode } from "react";
import { Link } from "react-router";
import type { OcrEngine } from "../lib/ocr.ts";

// The one description of the two engines, shown wherever a scan is about to be read
export function OcrEngineChoice({ value, onChange, note, tryHref, status, used = null }: { value: OcrEngine | null; onChange: (engine: OcrEngine) => void; note?: ReactNode; tryHref?: string; status?: ReactNode; used?: OcrEngine | null }) {
  const tag = (engine: OcrEngine) => (used === engine ? " — already done, keep it" : used ? " — reads every page again, slower, and replaces the copy you have" : value === null && engine === "tesseract" ? " (suggested)" : "");
  return (
    <div className="space-y-1.5 text-xs text-(--text-muted)" data-testid="book-ocr-engine">
      <span className="block text-(--text-secondary)">Pages that are pictures</span>
      <span className="block">
        {status ?? "The pages are images, so they are read once into a searchable copy kept beside the original; chapters, search and read-along all use that copy."}
      </span>
      {([
        ["tesseract", "Tesseract", "fast, about a second a page; highlights each word exactly"],
        ["surya", "Surya", "about ten times slower; better on photographed, curled or faded pages; highlights words at estimated spots"],
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
          <span><span className="text-(--text-secondary)">{name}</span> — {trade}{tag(engine)}</span>
        </label>
      ))}
      {note && <span className="block" data-testid="book-ocr-suggestion">{note}</span>}
      <span className="block">
        {tryHref ? (
          <><Link to={tryHref} className="text-(--accent-text) hover:text-(--accent-text-hover)" data-testid="book-ocr-try">Try one page…</Link>{" "}— compare both on a page you choose, next to the page itself, before deciding for the whole book.</>
        ) : (
          <>Try one page — both engines on a page you pick, with the image beside them — is on the book page once the upload lands.</>
        )}
      </span>
    </div>
  );
}
