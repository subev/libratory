import { useEffect, useReducer, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { trpc } from "../trpc.ts";
import type { RouterOutputs } from "../../../server/src/router.ts";
import { formatBytes } from "../lib/format.ts";
import { dur, preselectLanguage } from "../lib/ocr-try.ts";
import type { OcrEngine } from "../lib/ocr.ts";
import { packForBookLanguage, useOcrLanguages } from "../lib/use-ocr-languages.ts";
import { Button } from "../components/Button.tsx";
import { ModelBundleNotice } from "../components/ModelBundleNotice.tsx";
import { OcrLanguagePackRow } from "../components/OcrLanguagePackRow.tsx";
import { IconArrowLeft, IconAdd, IconChoose, IconChosen, IconHide, IconInfo, IconMinus, IconRerun, IconScan, IconScattered, IconShow, IconStop, IconCheck } from "../components/icons.tsx";

type TesseractResult = RouterOutputs["ocrTry"]["tesseract"];
type PageInfo = RouterOutputs["ocrTry"]["page"];
type SuryaLine = { text: string; bbox: [number, number, number, number] };
type SuryaState =
  | { status: "offer" | "warming" | "streaming" | "stopped" | "done" | "error"; lines: SuryaLine[]; total: number | null; startedAt: number; elapsedMs: number; error: string | null };
type SuryaAction =
  | { type: "start"; at: number }
  | { type: "detected"; total: number }
  | { type: "line"; line: SuryaLine }
  | { type: "done"; elapsedMs: number }
  | { type: "stop"; at: number }
  | { type: "error"; message: string }
  | { type: "reset" };

const SURYA_IDLE: SuryaState = { status: "offer", lines: [], total: null, startedAt: 0, elapsedMs: 0, error: null };

function suryaReducer(state: SuryaState, action: SuryaAction): SuryaState {
  switch (action.type) {
    case "start": return { ...SURYA_IDLE, status: "warming", startedAt: action.at };
    case "detected": return { ...state, total: action.total };
    case "line": return { ...state, status: "streaming", lines: [...state.lines, action.line] };
    case "done": return { ...state, status: "done", elapsedMs: action.elapsedMs };
    case "stop": return { ...state, status: "stopped", elapsedMs: action.at - state.startedAt };
    case "error": return { ...state, status: "error", error: action.message };
    case "reset": return SURYA_IDLE;
    default: {
      const unhandled: never = action;
      throw new Error(`unhandled action ${JSON.stringify(unhandled)}`);
    }
  }
}

// Surya's line rate is only known once lines arrive; before that the estimate is Tesseract's page × 10.
const SURYA_SLOWER = 10;

function Chip({ children, tone }: { children: React.ReactNode; tone: "idle" | "work" | "done" | "warn" }) {
  const cls = { idle: "bg-(--bg-subtle) text-(--text-muted)", work: "bg-(--badge-extracting-bg) text-(--badge-extracting-text)", done: "bg-(--success-bg) text-(--success-text)", warn: "bg-(--warning-bg) text-(--warning-text)" }[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{tone === "work" && <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}{children}</span>;
}

function Meta({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-xs">
      {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-(--text-faint)">{k}</dt><dd className="text-(--text-secondary) min-w-0">{v}</dd></div>))}
    </dl>
  );
}

function Shimmer({ n }: { n: number }) {
  return (
    <div className="flex gap-2 mt-0.5">
      <span className="w-[17px] shrink-0 text-right text-[10px] tabular-nums text-(--text-faint)">{n}</span>
      <span className="relative mt-1 h-[15px] flex-1 min-w-0 overflow-hidden rounded bg-(--bg-subtle)">
        <span className="absolute inset-0 w-[30%] bg-linear-to-r from-transparent via-(--accent-subtle) to-transparent animate-[slide-indeterminate_1.5s_linear_infinite]" />
      </span>
    </div>
  );
}

export function OcrTryPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fileIndex = Number(searchParams.get("file") ?? 0) || 0;

  const book = trpc.books.get.useQuery({ id }, { enabled: Boolean(id) });
  const { languages } = useOcrLanguages();
  const [pageWanted, setPageWanted] = useState(5);
  const pageQuery = trpc.ocrTry.page.useQuery({ bookId: id, fileIndex, page: pageWanted }, { enabled: Boolean(id), staleTime: Infinity });
  const info: PageInfo | undefined = pageQuery.data;
  const page = info?.page ?? pageWanted;

  const [pickedLanguage, setPickedLanguage] = useState<string | null>(null);
  const known = new Set(languages.map((l) => l.code));
  const detected = (info?.candidates ?? []).filter((code) => known.has(code));
  const bookPack = packForBookLanguage(languages, book.data?.language ?? null);
  const language = pickedLanguage ?? preselectLanguage(book.data?.language ? bookPack?.code ?? null : null, detected);
  const languageEntry = languages.find((l) => l.code === language);
  const packInstalled = info?.installedLanguages.includes(language) ?? true;

  const tesseract = trpc.ocrTry.tesseract.useMutation();
  const [surya, dispatch] = useReducer(suryaReducer, SURYA_IDLE);
  const stream = useRef<EventSource | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [overlay, setOverlay] = useState(true);
  const [chosen, setChosen] = useState<OcrEngine | null>(null);
  const [loupe, setLoupe] = useState<{ x: number; y: number; ox: number; oy: number; w: number } | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const utils = trpc.useUtils();
  const update = trpc.books.updateSettings.useMutation({ onSuccess: () => void utils.books.get.invalidate({ id }) });

  const stopSurya = () => {
    stream.current?.close();
    stream.current = null;
  };
  useEffect(() => stopSurya, []);
  useEffect(() => {
    if (surya.status !== "warming" && surya.status !== "streaming") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [surya.status]);

  const changePage = (next: number) => {
    const clamped = Math.max(1, Math.min(next, info?.pageCount ?? next));
    if (clamped === pageWanted) return;
    stopSurya();
    dispatch({ type: "reset" });
    tesseract.reset();
    setPageWanted(clamped);
  };

  const runTesseract = () => tesseract.mutate({ bookId: id, fileIndex, page, language });
  const runSurya = () => {
    stopSurya();
    dispatch({ type: "start", at: Date.now() });
    const es = new EventSource(`/ocr/try/${id}/${fileIndex}/${page}/surya`);
    stream.current = es;
    es.onmessage = (m) => {
      const e: unknown = JSON.parse(m.data);
      if (typeof e !== "object" || e === null || !("event" in e)) return;
      const ev = e as { event: string; lines?: number; text?: string; bbox?: [number, number, number, number]; elapsedMs?: number; message?: string };
      if (ev.event === "detected" && typeof ev.lines === "number") dispatch({ type: "detected", total: ev.lines });
      else if (ev.event === "line" && typeof ev.text === "string" && ev.bbox) dispatch({ type: "line", line: { text: ev.text, bbox: ev.bbox } });
      else if (ev.event === "done") { dispatch({ type: "done", elapsedMs: ev.elapsedMs ?? Date.now() - surya.startedAt }); stopSurya(); }
      else if (ev.event === "error") { dispatch({ type: "error", message: ev.message ?? "Surya failed" }); stopSurya(); }
    };
    es.onerror = () => {
      if (stream.current === es) { dispatch({ type: "error", message: "The connection to the server dropped" }); stopSurya(); }
    };
  };
  const haltSurya = () => { stopSurya(); dispatch({ type: "stop", at: Date.now() }); };

  const commit = (engine: OcrEngine) => {
    setChosen(engine);
    update.mutate({ id, ocrEngine: engine, ...(engine === "tesseract" && languageEntry?.iso ? { language: languageEntry.iso } : {}) });
  };

  const title = book.data?.title ?? "";
  const pageCount = info?.pageCount ?? 0;
  const fileCount = book.data?.files?.length ?? 1;
  const result: TesseractResult | undefined = tesseract.data;
  const tessSeconds = result ? result.elapsedMs / 1000 : null;
  const suryaSeconds = surya.status === "done" ? surya.elapsedMs / 1000 : null;
  const suryaEstimate = suryaSeconds ?? (tessSeconds ? tessSeconds * SURYA_SLOWER : null);
  const tessTotal = tessSeconds && pageCount ? dur(tessSeconds * pageCount) : null;
  const suryaTotal = suryaEstimate && pageCount ? dur(suryaEstimate * pageCount) : null;
  const doubted = result ? result.lines.flatMap((l) => l.words).filter((w) => w.conf < 60) : [];
  const wordCount = result ? result.lines.reduce((n, l) => n + l.words.length, 0) : 0;
  const confPct = result?.confidence != null ? `${Math.round(result.confidence * 100)}%` : null;
  const elapsed = surya.status === "warming" || surya.status === "streaming" ? Math.max(0, Math.round((now - surya.startedAt) / 1000)) : 0;
  const suryaLeft = surya.total && surya.lines.length > 0 ? Math.max(1, Math.round(((now - surya.startedAt) / surya.lines.length) * (surya.total - surya.lines.length) / 1000)) : null;

  const callout = result?.callout;
  const evidence = !callout ? null : callout.kind === "clean"
    ? { icon: <IconCheck />, tone: "bg-(--success-bg) text-(--success-text)", head: "Nothing to report on this page.", body: `${confPct} average confidence and ${callout.count} doubted words, neither banded nor spread. Tesseract read it cleanly, so the slower engine would cost ${suryaTotal ?? "hours"} and give you paragraph-level read-along instead of word-level.` }
    : callout.kind === "edge"
      ? { icon: <IconScan />, tone: "bg-(--warning-bg) text-(--warning-text)", head: `All ${callout.count} doubted words fall in the ${callout.side}most ${callout.bandPct}% of the page.`, body: `One band, not scattered${callout.allLastWords ? " — and every one of them is a line's last word" : ""}. That is the edge that curled away from the lens, which is what Tesseract loses on a photographed page and what Surya reads in context.` }
      : { icon: <IconScattered />, tone: "bg-(--bg-subtle) text-(--text-secondary)", head: `The ${callout.count} doubted words are spread across the page, not banded at an edge.`, body: "So nothing here says this page was photographed — faint print, an unfamiliar face or an archaic orthography does the same. Surya may still read it better, but this is not the case it was added for: compare the two results yourself before spending the time." };

  const offerText = !result
    ? "Runs only when you ask. Tesseract's result, a second away, is usually enough to decide."
    : callout?.kind === "edge" ? `Tesseract lost the ${callout.side} edge of this page. This is the case Surya was added for.`
      : callout?.kind === "scattered" ? "Tesseract doubted words all over this page. Surya may read them better; the image decides."
        : `Tesseract read this page cleanly. Surya would cost ${suryaTotal ?? "hours"} over the book for the same words and coarser read-along.`;

  const shade = (w: { conf: number }) => (w.conf < 60 ? "rounded-[2px] bg-(--lowconf) shadow-[0_0_0_1px_var(--lowconf-ring)]" : "");
  // Once the words are placed, the pane shows the column of type and not the margins — the reader's
  // column view — so a line is readable at the pane's width. Before that, the whole page.
  const crop = (() => {
    if (!info) return null;
    const words = result?.lines.flatMap((l) => l.words) ?? [];
    if (words.length === 0) return { x: 0, y: 0, w: info.width, h: info.height };
    const pad = info.width * 0.015;
    const x0 = Math.max(0, Math.min(...words.map((w) => w.x0)) - pad);
    const y0 = Math.max(0, Math.min(...words.map((w) => w.y0)) - pad);
    const x1 = Math.min(info.width, Math.max(...words.map((w) => w.x1)) + pad);
    const y1 = Math.min(info.height, Math.max(...words.map((w) => w.y1)) + pad);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  })();
  const LOUPE_ZOOM = 2.4;
  const loupeW = Math.min(760, window.innerWidth - 24);
  const loupeH = 150;
  const busy = tesseract.isPending || surya.status === "warming" || surya.status === "streaming";

  return (
    <div className="min-h-screen flex flex-col bg-(--bg-page) text-(--text-primary)" data-testid="ocr-try-page">
      <header className="sticky top-0 z-20 flex min-h-12 flex-wrap items-center gap-3 border-b border-(--border) bg-(--bg-card) px-4 py-2 text-sm">
        <Link to={`/books/${id}`} className="flex items-center gap-1 text-(--accent-text) hover:text-(--accent-text-hover)" data-testid="ocr-try-back">
          <IconArrowLeft className="h-4 w-4" /><span className="truncate max-w-[40vw]">{title}</span>
        </Link>
        <span className="h-4 w-px bg-(--border)" />
        <h1 className="text-sm font-semibold">Try one page</h1>
        <span className="text-xs text-(--text-muted)">{fileCount} file{fileCount === 1 ? "" : "s"} · {pageCount} pages · no text layer</span>
      </header>

      <div className="flex flex-wrap items-center gap-4 border-b border-(--border) bg-(--bg-card) px-4 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-wider text-(--text-faint)">PAGE</span>
          <Button variant="icon" size="sm" onClick={() => changePage(page - 1)} disabled={page <= 1} aria-label="Previous page"><IconMinus /></Button>
          <input type="number" min={1} max={pageCount || undefined} value={page} onChange={(e) => changePage(Number(e.target.value))} className="w-16 rounded border border-(--border-input) bg-(--bg-input) px-1.5 py-1 text-center text-xs" data-testid="ocr-try-page-input" />
          <Button variant="icon" size="sm" onClick={() => changePage(page + 1)} disabled={pageCount > 0 && page >= pageCount} aria-label="Next page"><IconAdd /></Button>
          <span className="max-w-[26ch] text-(--text-muted)">Aim at the worst page you have, not the first one.</span>
        </div>
        <span className="h-4 w-px bg-(--border)" />
        <label className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-wider text-(--text-faint)">LANGUAGE</span>
          <select value={language} onChange={(e) => setPickedLanguage(e.target.value)} className="rounded border border-(--border-input) bg-(--bg-input) px-1.5 py-1 text-xs" data-testid="ocr-try-language">
            {detected.length > 0 && (
              <optgroup label={`Detected on this page — ${info?.script}`}>
                {detected.map((code) => { const l = languages.find((x) => x.code === code); return l ? <option key={code} value={code}>{l.name}{l.installed ? " — installed" : ` — ${formatBytes(l.bytes)} to download`}</option> : null; })}
              </optgroup>
            )}
            <optgroup label="Installed">
              {languages.filter((l) => l.installed && !detected.includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.name} — installed</option>)}
            </optgroup>
            <optgroup label={`All languages — ${languages.length}`}>
              {languages.filter((l) => !l.installed && !detected.includes(l.code)).map((l) => <option key={l.code} value={l.code}>{l.name} — {formatBytes(l.bytes)}</option>)}
            </optgroup>
          </select>
          <Chip tone={packInstalled ? "done" : "warn"}>{packInstalled ? "pack installed" : `pack not installed · ${languageEntry ? formatBytes(languageEntry.bytes) : ""}`}</Chip>
        </label>
        <span className="h-4 w-px bg-(--border)" />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-(--text-muted)">{result ? "Change the page or the language and run again." : packInstalled ? "Tesseract lands in about a second." : "Tesseract waits for the pack; Surya needs none."}</span>
          <Button variant="primary" size="sm" onClick={runTesseract} disabled={!info || !packInstalled || tesseract.isPending} data-testid="ocr-try-run">{tesseract.isPending ? "Reading…" : result ? "Run again" : "Run Tesseract"}</Button>
        </div>
      </div>

      {!packInstalled && (
        <div className="border-b border-(--border) bg-(--bg-card) px-4 py-2">
          <OcrLanguagePackRow code={language} onInstalled={() => void pageQuery.refetch()} installedHint="Selected and ready — run the page now, without closing anything." offlineHint="Surya needs no language data, so it can still read this page." />
        </div>
      )}

      <main className="flex flex-1 flex-wrap items-start gap-4 px-4 pb-20 pt-4">
        <section className="sticky top-[62px] flex min-w-[280px] max-w-[560px] flex-[1_1_320px] flex-col self-stretch rounded-lg border border-(--border) bg-(--bg-card) p-3 text-xs" data-testid="ocr-try-image-pane">
          <div className="flex items-baseline gap-2"><span className="text-[13px] font-semibold">The page</span><span className="text-(--text-faint)">page {page} · rendered at 150 dpi</span></div>
          <p className="mt-0.5 max-w-[44ch] text-(--text-muted)">Ground truth. Neither transcription can be judged without it.</p>
          <div className="relative mt-2 max-h-[75vh] overflow-auto rounded bg-(--bg-subtle) p-2">
            {info && crop && (
              <div
                className="relative mx-auto w-full cursor-crosshair overflow-hidden"
                style={{ aspectRatio: `${crop.w} / ${crop.h}` }}
                onMouseMove={(e) => {
                  const r = image.current?.getBoundingClientRect();
                  if (r) setLoupe({ x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width });
                }}
                onMouseLeave={() => setLoupe(null)}
              >
                <img
                  ref={image}
                  src={info.imageUrl}
                  alt={`Page ${page}`}
                  className="absolute max-w-none"
                  style={{ width: `${(info.width / crop.w) * 100}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%` }}
                  data-testid="ocr-try-image"
                />
                {overlay && result && doubted.map((w, i) => (
                  <span key={i} className="pointer-events-none absolute rounded-[2px] bg-(--lowconf) shadow-[0_0_0_1px_var(--lowconf-ring)]" style={{ left: `${((w.x0 - crop.x) / crop.w) * 100}%`, top: `${((w.y0 - crop.y) / crop.h) * 100}%`, width: `${((w.x1 - w.x0) / crop.w) * 100}%`, height: `${((w.y1 - w.y0) / crop.h) * 100}%` }} />
                ))}
              </div>
            )}
          </div>
          {loupe && info && (
            <div
              className="pointer-events-none fixed z-30 overflow-hidden rounded-md border border-(--border) bg-(--bg-card) shadow-lg"
              style={{
                width: loupeW,
                height: loupeH,
                left: Math.max(8, Math.min(loupe.x - loupeW / 2, window.innerWidth - loupeW - 8)),
                top: loupe.y - loupeH - 18 < 8 ? loupe.y + 24 : loupe.y - loupeH - 18,
                backgroundImage: `url(${info.imageUrl})`,
                backgroundRepeat: "no-repeat",
                backgroundSize: `${loupe.w * LOUPE_ZOOM}px auto`,
                backgroundPosition: `${loupeW / 2 - loupe.ox * LOUPE_ZOOM}px ${loupeH / 2 - loupe.oy * LOUPE_ZOOM}px`,
              }}
            />
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => setOverlay((v) => !v)} disabled={!result} data-testid="ocr-try-overlay">{overlay ? <IconShow /> : <IconHide />}{result ? `Where Tesseract doubted · ${doubted.length}` : "Where Tesseract doubted"}</Button>
            <span className="ml-auto text-(--text-faint)">Hover to magnify</span>
          </div>
          {evidence && (
            <div className={`mt-2 flex items-start gap-2 rounded-md px-3 py-2 ${evidence.tone}`} data-testid={`ocr-try-callout-${callout?.kind}`}>
              <span className="mt-0.5 shrink-0">{evidence.icon}</span>
              <span><strong>{evidence.head}</strong> {evidence.body}</span>
            </div>
          )}
        </section>

        <div className="flex min-w-[280px] flex-[2_1_470px] flex-wrap items-stretch gap-4">
          <section className="flex min-w-[280px] flex-[1_1_300px] flex-col rounded-lg border border-(--border) bg-(--bg-card) p-3 text-xs" data-testid="ocr-try-tesseract">
            <div className="flex items-center gap-2"><span className="text-[13px] font-semibold">Tesseract</span>
              {!packInstalled ? <Chip tone="warn">needs {languageEntry?.name}</Chip> : tesseract.isPending ? <Chip tone="work">reading</Chip> : result ? <Chip tone="done">done in {tessSeconds?.toFixed(1)}s</Chip> : tesseract.error ? <Chip tone="warn">failed</Chip> : <Chip tone="idle">not run</Chip>}
            </div>
            <div className="mt-2"><Meta rows={[["Speed", result ? `${tessSeconds?.toFixed(1)}s on page ${page}, measured` : "about a second a clean page, longer on a damaged one"], ["Read-along", "word by word"], ["Damaged page", "degrades — margins first"], ["This book", tessTotal ? `${tessTotal} for ${pageCount} pages at this rate` : "minutes, not hours"]]} /></div>
            {tesseract.isPending && <div className="mt-2 h-[3px] overflow-hidden rounded bg-(--bg-subtle)"><div className="h-full w-[30%] bg-(--badge-extracting-text) animate-[slide-indeterminate_1.5s_linear_infinite]" /></div>}
            {result && confPct && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-(--text-faint)">Average confidence</span>
                <span className={`text-lg font-semibold ${callout?.kind === "clean" ? "text-(--success-text)" : "text-(--warning-text)"}`}>{confPct}</span>
                <span className="inline-block h-[11px] w-[11px] rounded-[2px] bg-(--lowconf) shadow-[0_0_0_1px_var(--lowconf-ring)]" />
                <span className="text-(--text-muted)">{doubted.length} of {wordCount} words scored under 60%</span>
              </div>
            )}
            <div className="mt-2 flex-1 overflow-auto font-serif text-[13px] leading-relaxed" style={{ overflowWrap: "anywhere" }}>
              {!packInstalled && <p className="text-(--text-muted)">Tesseract can't read this page without the <strong>{languageEntry?.name}</strong> pack. Surya needs no language data and can run on its own.</p>}
              {packInstalled && !result && !tesseract.isPending && !tesseract.error && <p className="text-(--text-muted)">Not run yet. This pane fills in within seconds of pressing Run.</p>}
              {tesseract.isPending && <p className="text-(--text-muted)">Reading page {page}…</p>}
              {tesseract.error && <p className="text-(--warning-text)" data-testid="ocr-try-tesseract-error">{tesseract.error.message}</p>}
              {result && result.lines.map((l, i) => (
                <div key={i} className="flex gap-2"><span className="w-[17px] shrink-0 text-right text-[10px] tabular-nums text-(--text-faint)">{i + 1}</span><span className="min-w-0">{l.words.map((w, j) => <span key={j}><span className={shade(w)}>{w.text}</span> </span>)}</span></div>
              ))}
            </div>
            <div className="mt-3 flex items-end gap-2">
              {result && <span className="max-w-[32ch] text-(--text-faint)">{languageEntry && !languageEntry.iso ? `${languageEntry.name} has no book language to save; the run will pick a pack from the page's script unless the book's language is set.` : "Shaded words are the ones Tesseract itself scored under 60% — its own doubt, not our judgement."}</span>}
              <Button variant={chosen === "tesseract" ? "success" : "primary"} size="sm" className="ml-auto" onClick={() => commit("tesseract")} disabled={!result || update.isPending} data-testid="ocr-try-use-tesseract">{chosen === "tesseract" ? <IconChosen /> : <IconChoose />}{chosen === "tesseract" ? "Using Tesseract" : "Use Tesseract for this book"}</Button>
            </div>
          </section>

          <section className="flex min-w-[280px] flex-[1_1_300px] flex-col rounded-lg border border-(--border) bg-(--bg-card) p-3 text-xs" data-testid="ocr-try-surya">
            <div className="flex items-center gap-2"><span className="text-[13px] font-semibold">Surya</span>
              {surya.status === "warming" || surya.status === "streaming" ? <Chip tone="work">reading</Chip> : surya.status === "done" ? <Chip tone="done">done in {Math.round(surya.elapsedMs / 1000)}s</Chip> : surya.status === "stopped" ? <Chip tone="idle">stopped</Chip> : surya.status === "error" ? <Chip tone="warn">failed</Chip> : <Chip tone="idle">not run</Chip>}
            </div>
            <div className="mt-2"><Meta rows={[["Speed", suryaSeconds ? `${Math.round(suryaSeconds)}s on page ${page}, measured` : "roughly ten times slower — about a minute a page"], ["Read-along", "a paragraph at a time"], ["Damaged page", "still accurate"], ["This book", suryaSeconds && suryaTotal ? `${suryaTotal} for ${pageCount} pages at this rate` : suryaTotal ? `${suryaTotal}, guessing ten times Tesseract's rate` : "longer — measure it here first"]]} /></div>
            {(surya.status === "warming" || surya.status === "streaming") && <div className="mt-2 h-[3px] overflow-hidden rounded bg-(--bg-subtle)"><div className="h-full w-[30%] bg-(--accent) animate-[slide-indeterminate_1.5s_linear_infinite]" /></div>}
            {surya.status !== "offer" && (
              <div className="mt-2 flex items-center gap-2 text-(--text-muted)" data-testid="ocr-try-surya-meter">
                <span className="min-w-0 flex-1">
                  {surya.status === "streaming" && `Line ${Math.max(1, surya.lines.length)} of ${surya.total ?? "?"} · ${elapsed}s elapsed${suryaLeft !== null ? ` · about ${suryaLeft}s left` : ""}`}
                  {surya.status === "warming" && `${elapsed}s elapsed`}
                  {surya.status === "done" && `${surya.lines.length} lines · ${Math.round(surya.elapsedMs / 1000)}s · nothing dropped`}
                  {surya.status === "stopped" && (surya.lines.length > 0 ? `Stopped at line ${surya.lines.length} of ${surya.total ?? "?"}. Tesseract's result is untouched.` : "Stopped before the first line came back — nothing to show. Tesseract's result is untouched.")}
                  {surya.status === "error" && <span className="text-(--warning-text)">{surya.error}</span>}
                </span>
                {(surya.status === "warming" || surya.status === "streaming") && <Button size="sm" onClick={haltSurya} data-testid="ocr-try-surya-stop"><IconStop />Stop</Button>}
                {(surya.status === "stopped" || surya.status === "error") && <Button size="sm" onClick={runSurya}><IconRerun />Run Surya again</Button>}
              </div>
            )}
            <div className="mt-2 flex-1 overflow-auto font-serif text-[13px] leading-relaxed" style={{ overflowWrap: "anywhere" }}>
              {surya.status === "offer" && (info && !info.bundleInstalled ? <ModelBundleNotice id="extraction" verb="Surya" /> : (
                <div className="space-y-2">
                  <p className="text-(--text-muted)">{offerText}</p>
                  <Button variant="primary" size="sm" onClick={runSurya} disabled={!info} data-testid="ocr-try-run-surya">Run Surya on page {page}{suryaEstimate ? ` · ${dur(suryaEstimate)}` : ""}</Button>
                  <p className="text-(--text-faint)">It never starts on its own — a minute of your GPU is not something to spend by accident.</p>
                </div>
              ))}
              {surya.status === "warming" && <p className="text-(--text-muted)">Loading the recognition model — the first line takes the longest.</p>}
              {surya.lines.map((l, i) => (<div key={i} className="flex gap-2"><span className="w-[17px] shrink-0 text-right text-[10px] tabular-nums text-(--text-faint)">{i + 1}</span><span className="min-w-0">{l.text}</span></div>))}
              {surya.status === "streaming" && <Shimmer n={surya.lines.length + 1} />}
            </div>
            <div className="mt-3 flex items-end gap-2">
              {surya.status === "done" && <span className="max-w-[30ch] text-(--text-faint)">No confidence figure: Surya reports none, so there is nothing to compare against {confPct ?? "Tesseract's"}.</span>}
              <Button variant={chosen === "surya" ? "success" : "primary"} size="sm" className="ml-auto" onClick={() => commit("surya")} disabled={surya.status !== "done" || update.isPending} data-testid="ocr-try-use-surya">{chosen === "surya" ? <IconChosen /> : <IconChoose />}{chosen === "surya" ? "Using Surya" : "Use Surya for this book"}</Button>
            </div>
          </section>
        </div>
      </main>

      <footer className={`sticky bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-(--border) px-4 py-2.5 text-xs backdrop-blur ${chosen ? "bg-(--bg-selected)" : "bg-(--bg-card)/95"}`} data-testid="ocr-try-commit">
        <span className="shrink-0">{chosen ? <IconChosen /> : <IconInfo />}</span>
        <span className="min-w-0 flex-1">
          {!chosen ? (
            <><strong>Nothing is committed yet.</strong> Choosing an engine here saves it on the book — all {pageCount} pages, and every extraction after this one. Whole-book times are extrapolated from the page you sampled, so a different page gives different numbers.</>
          ) : (
            <><strong>{chosen === "tesseract" ? "Tesseract" : "Surya"} is set on {title}.</strong> All {pageCount} pages at the rate page {page} ran — {chosen === "tesseract" ? tessTotal : suryaTotal} — and read-along will mark {chosen === "tesseract" ? "words" : "a paragraph at a time"}. Saved on the book: every extraction from now on uses it until you change it.</>
          )}
          {update.error && <span className="block text-(--danger-text)">{update.error.message}</span>}
        </span>
        <Button variant={chosen ? "primary" : "secondary"} size="sm" onClick={() => { stopSurya(); navigate(`/books/${id}?extract=1`); }} disabled={busy && !chosen} title={chosen ? "Returns to the Extract dialog with your other settings as you left them; the engine is already saved" : "Returns to the Extract dialog; no engine is saved"} data-testid="ocr-try-back-extract">{chosen ? "Back to Extract" : "Cancel"}</Button>
      </footer>
    </div>
  );
}
