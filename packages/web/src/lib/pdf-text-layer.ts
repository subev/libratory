import * as pdfjs from "pdfjs-dist";
// eslint-disable-next-line import/default -- Vite's ?url suffix makes the module's URL the default export
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { preparePdfWorker } from "./map-get-or-insert.ts";

// Past this the file is read on the server alone: fifty dropped scans must not become a gigabyte in the tab
const PROBE_LIMIT_BYTES = 25 * 1024 * 1024;

// A cover and a title page are often pictures even in a born-digital book, so a few pages from
// across the file are asked, not the first ones. The server's own probe decides in the end.
export type PdfProbe = { hasText: boolean | null; sample: string };

const SAMPLE_CHARS = 6_000;

export async function probePdf(file: File): Promise<PdfProbe> {
  if (file.size > PROBE_LIMIT_BYTES) return { hasText: null, sample: "" };
  pdfjs.GlobalWorkerOptions.workerSrc ||= preparePdfWorker(new URL(workerUrl, import.meta.url).href);
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
    const doc = await task.promise;
    const n = doc.numPages;
    const pages = [...new Set([1, 2, Math.ceil(n / 2), n].filter((p) => p >= 1 && p <= n))];
    let sample = "";
    for (const number of pages) {
      const content = await (await doc.getPage(number)).getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").trim();
      if (text) sample = `${sample} ${text}`.slice(0, SAMPLE_CHARS);
    }
    return { hasText: sample.length > 0, sample };
  } catch {
    return { hasText: null, sample: "" };
  } finally {
    await task.destroy().catch(() => {});
  }
}
