import { fetchCues, fetchManifest, fetchText, type ReaderCues, type ReaderManifest, type ReaderText } from "./reader-doc.ts";
import { Zip } from "./zip.ts";
import { readBilingualDocument, type BilingualDocument } from "../../../server/src/lib/bilingual-format.ts";

// The reader consumes two documents and never knew where they came from; this is the seam that
// makes that literally true. A server answers over HTTP, a container answers out of a zip, and a
// pocket client answers off its own disk — none of them a change to anything that draws a page.
export type DocumentSource = {
  manifest(): Promise<ReaderManifest>;
  cues(url: string): Promise<ReaderCues>;
  text(url: string): Promise<ReaderText>;
  bilingual(url: string): Promise<BilingualDocument>;
  // Where the bytes for a URL in the manifest actually are, for <audio> and pdf.js
  resolve(url: string | null | undefined): string | undefined;
  close(): void;
};

export function httpSource(bookId: string): DocumentSource {
  return {
    manifest: () => fetchManifest(bookId),
    cues: (url) => fetchCues(url),
    text: (url) => fetchText(url),
    bilingual: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Bilingual document unavailable (${response.status})`);
      return readBilingualDocument(await response.json());
    },
    resolve: (url) => url ?? undefined,
    close: () => {},
  };
}

// Relative to book.json, wherever the writer put it: `../audio/ch000.m4a` from `OEBPS/p2af/`
// is the EPUB layer's own audio, which is the one copy both layers share.
const BASE = "p2af:/";

function resolver(manifestPath: string) {
  const base = new URL(manifestPath, BASE);
  return (url: string) => new URL(url, base).pathname.slice(1);
}

export async function containerSource(file: Blob): Promise<DocumentSource> {
  const zip = await Zip.open(file);
  const manifestPath = zip.names().find((name) => name.endsWith("p2af/book.json"));
  if (!manifestPath) {
    throw new Error("This file has no read-along layer — it may be an ordinary EPUB");
  }

  const at = resolver(manifestPath);
  const manifest = await zip.json<ReaderManifest>(manifestPath);

  // Audio and PDFs are stored rather than deflated, so a URL for each is a slice of the file
  // and costs no reading — which is what lets every one of them be handed out up front.
  const urls = new Map<string, string>();
  let closed = false;
  const wanted = [
    ...manifest.sources.map((source) => source.url),
    ...manifest.chapters.flatMap((chapter) => (chapter.audio ? [chapter.audio] : [])),
  ];
  await Promise.all(
    wanted.map(async (url) => {
      const path = at(url);
      if (zip.has(path)) urls.set(url, await zip.url(path));
    }),
  );

  return {
    manifest: async () => manifest,
    cues: (url) => zip.json<ReaderCues>(at(url)),
    text: (url) => zip.json<ReaderText>(at(url)),
    bilingual: async (url) => {
      const doc = readBilingualDocument(await zip.json<unknown>(at(url)));
      if (closed) throw new Error("This book is closed");
      for (const lane of [doc.source, doc.target]) {
        const audio = lane.narration?.audio;
        if (!audio || urls.has(audio)) continue;
        if (!zip.has(at(audio))) { lane.narration = null; continue; }
        // Audio references, like every p2af URL, are relative to book.json, not this document.
        const blobUrl = await zip.url(at(audio));
        if (closed) { zip.close(); throw new Error("This book is closed"); }
        urls.set(audio, blobUrl);
      }
      return doc;
    },
    resolve: (url) => (url ? urls.get(url) : undefined),
    close: () => { closed = true; urls.clear(); zip.close(); },
  };
}
