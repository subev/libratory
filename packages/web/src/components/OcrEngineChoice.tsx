import type { ReactNode } from "react";
import { Link } from "react-router";
import { DEFAULT_OCR_ENGINE, formatLlmOcrCost, type OcrEngine } from "../lib/ocr.ts";
import { trpc } from "../trpc.ts";
import { ModelPicker } from "./ModelPicker.tsx";

const ENGINE_NAMES: Record<OcrEngine, string> = { tesseract: "Tesseract", surya: "Surya", llm: "the AI model" };

// The one description of the three engines, shown wherever a scan is about to be read
export function OcrEngineChoice({ value, onChange, model, onModelChange, pageCount = null, note, tryHref, status, used = null }: {
  value: OcrEngine | null;
  onChange: (engine: OcrEngine) => void;
  /** The vision model for the AI engine; "" or null = the Settings default. */
  model: string | null;
  onModelChange: (key: string) => void;
  pageCount?: number | null;
  note?: ReactNode;
  tryHref?: string;
  status?: ReactNode;
  used?: OcrEngine | null;
}) {
  // From memory on the server, not llmModels.status, which probes every local server: the AI engine
  // only needs to know whether any cloud key exists, because that is the only way page images leave.
  const { data: secrets } = trpc.secrets.list.useQuery(undefined, { staleTime: 60 * 1000 });
  const cloudKey = secrets === undefined ? null : secrets.keys.some((k) => k.kind === "llm" && k.configured);
  const chosen = value ?? DEFAULT_OCR_ENGINE;
  const tag = (engine: OcrEngine) => (used === engine ? " — already done, nothing to wait for" : value === null && engine === DEFAULT_OCR_ENGINE ? " (suggested)" : "");
  const switching = used !== null && chosen !== used;
  const engines: { engine: OcrEngine; name: string; trade: string; disabled?: string }[] = [
    { engine: "tesseract", name: "Tesseract", trade: "fast, about a second a page; highlights each word exactly" },
    { engine: "surya", name: "Surya", trade: "about ten times slower; better on photographed, curled or faded pages; highlights words at estimated spots" },
    {
      engine: "llm",
      name: "AI model (cloud)",
      trade: "sends each page image to a vision model, which joins split words and leaves headers and page numbers out; minutes per book; its words are placed on the page by a local Tesseract read, so search and highlighting need the language pack",
      disabled: cloudKey === false ? "Add an AI provider key in Settings first — the page images have to go somewhere" : undefined,
    },
  ];
  return (
    <div className="space-y-1.5 text-xs text-(--text-muted)" data-testid="book-ocr-engine">
      <span className="block text-(--text-secondary)">Pages that are pictures</span>
      <span className="block">
        {status ?? "The pages are images, so they are read once into a searchable copy kept beside the original; chapters, search and read-along all use that copy."}
      </span>
      {engines.map(({ engine, name, trade, disabled }) => (
        <label key={engine} className={`flex gap-2 ${disabled ? "opacity-60" : ""}`} title={disabled}>
          <input
            type="radio"
            name="ocr-engine"
            checked={chosen === engine}
            disabled={disabled !== undefined}
            onChange={() => onChange(engine)}
            className="mt-0.5"
            data-testid={`book-ocr-engine-${engine}`}
          />
          <span><span className="text-(--text-secondary)">{name}</span> — {trade}{tag(engine)}</span>
        </label>
      ))}
      {cloudKey === false && (
        <span className="block pl-6" data-testid="book-ocr-llm-needs-key">
          The AI model needs an API key for DeepSeek, OpenAI, Anthropic or Google Gemini — add one in Settings on the home page.
        </span>
      )}
      {chosen === "llm" && (
        <div className="space-y-1.5 pl-6" data-testid="book-ocr-llm">
          <div className="flex items-center gap-2">
            <span>Model</span>
            <ModelPicker value={model ?? ""} onChange={onModelChange} requireVision testId="book-ocr-model" />
          </div>
          <span className="block">
            Every page image leaves this machine for the model's provider. {pageCount !== null ? `${pageCount} page${pageCount === 1 ? "" : "s"} cost ${formatLlmOcrCost(pageCount)} at DeepSeek Flash prices` : "Roughly a tenth of a cent a page at DeepSeek Flash prices"}; other providers charge their own rates. Each page is checked against a local Tesseract read, and pages that come back short are read a second time.
          </span>
        </div>
      )}
      {switching && (
        <span className="block text-(--warning-text)" data-testid="book-ocr-switching">
          You will wait: every page is read again with {chosen === "surya" ? "Surya, about ten times slower than Tesseract" : ENGINE_NAMES[chosen]}, and the {used === "llm" ? "text you already have is" : "copy you already have is"} replaced. Extraction starts after that.
        </span>
      )}
      {note && <span className="block" data-testid="book-ocr-suggestion">{note}</span>}
      <span className="block">
        {tryHref ? (
          <><Link to={tryHref} className="text-(--accent-text) hover:text-(--accent-text-hover)" data-testid="book-ocr-try">Try one page…</Link>{" "}— compare Tesseract and Surya on a page you choose, next to the page itself, before deciding for the whole book.</>
        ) : (
          <>Try one page — Tesseract and Surya on a page you pick, with the image beside them — is on the book page once the upload lands.</>
        )}
      </span>
    </div>
  );
}
