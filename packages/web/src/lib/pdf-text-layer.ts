import * as pdfjs from "pdfjs-dist";
// eslint-disable-next-line import/default -- Vite's ?url suffix makes the module's URL the default export
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { preparePdfWorker } from "./map-get-or-insert.ts";

// Past this the file is read on the server alone: fifty dropped scans must not become a gigabyte in the tab
const PROBE_LIMIT_BYTES = 25 * 1024 * 1024;

// A cover and a title page are often pictures even in a born-digital book, so a few pages from
// across the file are asked, not the first ones. The server's own probe decides in the end.
export async function hasTextLayer(file: File): Promise<boolean | null> {
  if (file.size > PROBE_LIMIT_BYTES) return null;
  pdfjs.GlobalWorkerOptions.workerSrc ||= preparePdfWorker(new URL(workerUrl, import.meta.url).href);
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
    const doc = await task.promise;
    const n = doc.numPages;
    const pages = [...new Set([1, 2, Math.ceil(n / 2), n].filter((p) => p >= 1 && p <= n))];
    for (const number of pages) {
      const content = await (await doc.getPage(number)).getTextContent();
      if (content.items.some((item) => "str" in item && item.str.trim())) return true;
    }
    return false;
  } catch {
    return null;
  } finally {
    await task.destroy().catch(() => {});
  }
}
