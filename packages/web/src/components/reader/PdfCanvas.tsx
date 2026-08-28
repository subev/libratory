import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
// eslint-disable-next-line import/default -- Vite's ?url suffix makes the module's URL the default export; the resolver only sees the .mjs behind it
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { preparePdfWorker } from "../../lib/map-get-or-insert.ts";

pdfjs.GlobalWorkerOptions.workerSrc = preparePdfWorker(new URL(workerUrl, import.meta.url).href);

// A retained document pins its bytes and pdf.js's page and font caches — tens of MB each. The
// reader shows one book at a time, so anything older than the last two is a leak.
const KEEP_DOCUMENTS = 2;
const documents = new Map<string, pdfjs.PDFDocumentLoadingTask>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let task = documents.get(url);
  if (!task) {
    task = pdfjs.getDocument({
      url,
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    });
    documents.set(url, task);
    for (const [stale, old] of [...documents].slice(0, -KEEP_DOCUMENTS)) {
      old.destroy().catch(() => {});
      documents.delete(stale);
    }
  }
  return task.promise;
}

// Rendered only near the viewport: a chapter can cover a hundred pages and stall the tab
export function PdfCanvas({
  url,
  pageNumber,
  crop,
  pageSize,
  children,
  onPointer,
  onHover,
  pointer = false,
}: {
  url: string;
  pageNumber: number;
  // [x, y, width, height] in PDF points; the whole page is just the full-page crop
  crop: [number, number, number, number];
  pageSize: { w: number; h: number };
  children?: React.ReactNode;
  // Report where the pointer landed on the whole page, in ten-thousandths
  onPointer?: (x: number, y: number) => void;
  onHover?: (point: [number, number] | null) => void;
  pointer?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [x, y, width, height] = crop;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && setVisible(true)),
      { rootMargin: "1200px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    (async () => {
      const document = await loadPdf(url);
      const page = await document.getPage(pageNumber);
      const canvas = canvasRef.current;
      const host = hostRef.current;
      if (cancelled || !canvas || !host) return;

      const scale = (host.clientWidth / width) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
    })().catch((error) => {
      // A cancelled render is routine — pages leave the viewport. Everything else used to be
      // swallowed too, and a Safari missing one Map method drew blank pages with a clean console.
      if (!(error instanceof pdfjs.RenderingCancelledException)) {
        console.error("PDF page render failed:", error);
      }
    });

    return () => { cancelled = true; };
  }, [url, pageNumber, visible, x, y, width, height]);

  // Where the pointer is on the whole page, in the ten-thousandths the rects are stored in
  const pointAt = (event: React.MouseEvent<HTMLDivElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      ((x + ((event.clientX - box.left) / box.width) * width) / pageSize.w) * 10_000,
      ((y + ((event.clientY - box.top) / box.height) * height) / pageSize.h) * 10_000,
    ];
  };

  return (
    <div
      ref={hostRef}
      className={`relative w-full bg-white shadow-sm ${pointer ? "cursor-pointer" : ""}`}
      style={{ aspectRatio: String(width / height) }}
      data-testid="reader-page"
      data-page={pageNumber}
      onClick={(event) => onPointer?.(...pointAt(event))}
      onMouseMove={onHover ? (event) => onHover(pointAt(event)) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* Drawn whether or not the page has painted yet: the box is already the right size and in
          the right place, so this is what lets the reader be scrolled to a page it has not reached */}
      {children}
    </div>
  );
}
