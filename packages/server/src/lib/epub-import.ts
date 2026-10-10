import path from "node:path";
import { unzipSync } from "fflate";
import { DOMParser } from "linkedom";

// A file that is not an importable EPUB, as opposed to a failure of ours: the route answers it with 400.
export class EpubImportError extends Error {}

export type ParsedEpub = {
  title: string | null;
  author: string | null;
  language: string | null;
  // dc:description, with any markup a publisher put in it reduced to text
  description: string | null;
  chapters: { title: string; text: string }[];
};

// The slice of the DOM this reads. The server compiles without the DOM lib, and linkedom's own
// declarations lean on it, so its documents are read through this shape.
type DomNode = { nodeType: number; nodeValue: string | null; textContent: string | null; childNodes: Iterable<DomNode> };
type DomElement = DomNode & {
  localName: string;
  tagName: string;
  children: Iterable<DomElement>;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): Iterable<DomElement>;
};
type DomDocument = { documentElement: DomElement | null; getElementsByTagName(name: string): Iterable<DomElement> };

function parseXml(markup: string): DomDocument {
  return new DOMParser().parseFromString(markup, "text/xml") as unknown as DomDocument;
}

type ManifestItem = { id: string; href: string; mediaType: string; properties: string[] };
type TocEntry = { title: string; target: string | null; children: TocEntry[] };

const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const BINARY_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?|svg|ttf|otf|woff2?|eot|mp3|m4a|mp4|ogg|oga|wav|webm|pdf)$/i;
// A part's own page is its title and maybe an epigraph; past this it is real text with sections inside
const PART_LEAD_WORDS = 150;
const FRONT_MATTER_WORDS = 50;

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "ol", "p", "pre", "section",
  "table", "td", "th", "tr", "ul",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const SKIP_TAGS = new Set(["head", "script", "style", "nav", "img", "svg", "math", "audio", "video", "object", "iframe", "map"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// Print furniture and notes: page-break markers carry the printed page number, note references a digit
const SKIP_EPUB_TYPES = new Set([
  "pagebreak", "page-list", "noteref", "footnote", "footnotes", "endnote", "endnotes", "rearnote", "rearnotes",
  "note", "toc", "landmarks",
]);
const SKIP_ROLES = new Set([
  "doc-pagebreak", "doc-pagelist", "doc-noteref", "doc-footnote", "doc-endnote", "doc-endnotes", "doc-toc", "doc-backlink",
]);
// A paragraph that is only a page number: digits, or a lowercase roman numeral as front matter is numbered
const PAGE_NUMBER = /^[\s\-–—]*(?:\p{Nd}{1,5}|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))[\s\-–—]*$/u;
// The visible half of a note reference with no semantic markup: a link reading "12", "[3]", "*" or "†"
const NOTE_MARKER = /^[\s[(]*[\p{Nd}*†‡§¶]+[\s\])]*$/u;

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  const files = readZip(bytes);
  const text = (name: string) => {
    const data = files.get(name);
    return data ? decode(data) : null;
  };

  const opfPath = packagePath(text("META-INF/container.xml"), files);
  const opfText = text(opfPath);
  if (!opfText) throw new EpubImportError("The EPUB names a package file that is not in it");
  const opf = parseXml(opfText);
  const opfDir = path.posix.dirname(opfPath);

  const manifest = new Map<string, ManifestItem>();
  for (const el of elements(opf, "item")) {
    const id = el.getAttribute("id");
    const href = el.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: resolveHref(opfDir, href).file,
      mediaType: el.getAttribute("media-type") ?? "",
      properties: (el.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const navItem = [...manifest.values()].find((item) => item.properties.includes("nav")) ?? null;
  const spineEl = elements(opf, "spine")[0];
  const spine = elements(opf, "itemref")
    .filter((el) => el.getAttribute("linear") !== "no")
    .map((el) => manifest.get(el.getAttribute("idref") ?? ""))
    .filter((item): item is ManifestItem => item !== undefined && files.has(item.href));
  if (spine.length === 0) throw new EpubImportError("The EPUB has no readable documents in its reading order");

  refuseEncrypted(text("META-INF/encryption.xml"), spine);

  let toc = navItem ? navToc(text(navItem.href), navItem.href) : [];
  if (toc.length === 0) {
    const ncx = manifest.get(spineEl?.getAttribute("toc") ?? "")
      ?? [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
    if (ncx) toc = ncxToc(text(ncx.href), ncx.href);
  }

  const targets = new Set<string>();
  const collect = (entries: TocEntry[]) => entries.forEach((e) => {
    if (e.target) targets.add(e.target);
    collect(e.children);
  });
  collect(toc);

  const stream = readStream(spine, text, targets, navItem?.href ?? null);
  const boundaries = tocBoundaries(toc, stream);
  const chapters = boundaries.length >= 2 ? sliceChapters(stream, boundaries) : documentChapters(stream);
  if (chapters.length === 0) throw new EpubImportError("The EPUB has no text to read");

  return {
    title: firstText(opf, "title"),
    author: firstText(opf, "creator"),
    language: firstText(opf, "language"),
    description: descriptionText(elements(opf, "description")[0]?.textContent ?? null),
    chapters,
  };
}

function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (BINARY_EXTENSIONS.test(file.name)) return false;
        total += file.originalSize;
        if (total > MAX_TOTAL_BYTES) throw new EpubImportError("The EPUB's text is too large to import");
        return true;
      },
    });
  } catch (err) {
    if (err instanceof EpubImportError) throw err;
    throw new EpubImportError("Not an EPUB: the file is not a readable zip archive");
  }
  return new Map(Object.entries(entries));
}

function decode(data: Uint8Array): string {
  const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(data);
}

function packagePath(container: string | null, files: Map<string, Uint8Array>): string {
  const fromContainer = container
    ? elements(parseXml(container), "rootfile")[0]?.getAttribute("full-path")
    : null;
  if (fromContainer) return fromContainer;
  const opf = [...files.keys()].find((name) => name.toLowerCase().endsWith(".opf"));
  if (!opf) throw new EpubImportError("Not an EPUB: no package file (container.xml or .opf) inside");
  return opf;
}

// DRM encrypts the documents themselves; font obfuscation, which DRM-free books use too, only fonts.
function refuseEncrypted(encryption: string | null, spine: ManifestItem[]) {
  if (!encryption) return;
  const doc = parseXml(encryption);
  const encrypted = new Set(elements(doc, "CipherReference").map((el) => resolveHref("", el.getAttribute("URI") ?? "").file));
  if (spine.some((item) => encrypted.has(item.href))) {
    throw new EpubImportError("This EPUB is DRM-protected, so its text cannot be read. Only DRM-free EPUBs can be imported.");
  }
}

// Zip paths are relative to the referring file and percent-encoded in hrefs
function resolveHref(baseDir: string, href: string): { file: string; fragment: string | null } {
  const hash = href.indexOf("#");
  const rawPath = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? null : href.slice(hash + 1) || null;
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // A stray % in a file name; the raw spelling is the best guess
  }
  const file = path.posix.normalize(path.posix.join(baseDir, decoded)).replace(/^(\.\/)+/, "");
  return { file, fragment };
}

function targetKey(baseFile: string, href: string): string {
  if (href.startsWith("#")) return href.length > 1 ? `${baseFile}${href}` : baseFile;
  const { file, fragment } = resolveHref(path.posix.dirname(baseFile), href);
  return fragment ? `${file}#${fragment}` : file;
}

function localName(el: DomElement): string {
  const name = el.localName ?? el.tagName;
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

// Namespace prefixes vary between packages (dc:title, opf:item), so match on the local name.
function elements(root: DomDocument | DomElement, name: string): DomElement[] {
  const wanted = name.toLowerCase();
  return descendants(root).filter((el) => localName(el) === wanted);
}

// linkedom answers getElementsByTagName("*") with nothing, so the tree is walked by hand
function descendants(root: DomDocument | DomElement): DomElement[] {
  const out: DomElement[] = [];
  const visit = (el: DomElement) => {
    out.push(el);
    for (const child of el.children) visit(child);
  };
  if ("documentElement" in root) {
    if (root.documentElement) visit(root.documentElement);
  } else {
    for (const child of root.children) visit(child);
  }
  return out;
}

// Publishers put HTML inside dc:description; paragraph breaks survive as blank lines, tags go,
// and the cap counts characters rather than code units so it cannot split a pair
export function descriptionText(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<\/p>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  return text ? Array.from(text).slice(0, 2000).join("") : null;
}

function firstText(root: DomDocument, name: string): string | null {
  const value = elements(root, name)[0]?.textContent?.replace(/\s+/g, " ").trim();
  return value || null;
}

// XHTML parsed as XML keeps `<span/>` empty but leaves HTML entities undecoded; parsed as HTML it
// decodes them but lets a self-closed page-break span swallow the text after it. Closing the tags
// explicitly and parsing as HTML gets both, and tolerates the sloppy markup older EPUBs carry.
function parseXhtml(markup: string): DomDocument {
  const closed = markup.replace(/<([A-Za-z][\w:.-]*)((?:\s[^<>]*?)?)\s*\/>/g, (_, tag: string, attrs: string) =>
    VOID_TAGS.has(tag.toLowerCase()) ? `<${tag}${attrs}>` : `<${tag}${attrs}></${tag}>`);
  return new DOMParser().parseFromString(closed, "text/html") as unknown as DomDocument;
}

function tokens(el: DomElement, attr: string): string[] {
  return (el.getAttribute(attr) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function cleanLabel(text: string | null | undefined): string {
  return (text ?? "").replace(/\[\p{Nd}+\]/gu, "").replace(/\s+/g, " ").trim();
}

function navToc(markup: string | null, navFile: string): TocEntry[] {
  if (!markup) return [];
  const doc = parseXhtml(markup);
  const navs = [...doc.getElementsByTagName("nav")];
  // The nav document also holds the page list and landmarks; only the table of contents names chapters
  const nav = navs.find((n) => tokens(n, "epub:type").includes("toc") || tokens(n, "role").includes("doc-toc"))
    ?? navs.find((n) => !n.getAttribute("epub:type") && !n.getAttribute("role"));
  const list = nav ? [...nav.children].find((c) => localName(c) === "ol") : undefined;
  return list ? navList(list, navFile) : [];
}

function navList(list: DomElement, navFile: string): TocEntry[] {
  return [...list.children].filter((li) => localName(li) === "li").map((li) => {
    const label = [...li.children].find((c) => localName(c) === "a" || localName(c) === "span");
    const nested = [...li.children].find((c) => localName(c) === "ol");
    const href = label && localName(label) === "a" ? label.getAttribute("href") : null;
    return {
      title: cleanLabel(label?.textContent),
      target: href ? targetKey(navFile, href) : null,
      children: nested ? navList(nested, navFile) : [],
    };
  });
}

function ncxToc(markup: string | null, ncxFile: string): TocEntry[] {
  if (!markup) return [];
  const doc = parseXml(markup);
  const navMap = elements(doc, "navMap")[0];
  return navMap ? ncxPoints(navMap, ncxFile) : [];
}

function ncxPoints(parent: DomElement, ncxFile: string): TocEntry[] {
  return [...parent.children].filter((el) => localName(el) === "navpoint").map((point) => {
    const label = [...point.children].find((c) => localName(c) === "navlabel");
    const content = [...point.children].find((c) => localName(c) === "content");
    const src = content?.getAttribute("src");
    return {
      title: cleanLabel(label?.textContent),
      target: src ? targetKey(ncxFile, src) : null,
      children: ncxPoints(point, ncxFile),
    };
  });
}

type Stream = {
  blocks: string[];
  // Where each table-of-contents target starts: a document, or an id inside one
  marks: Map<string, number>;
  // Where each document starts, in reading order, with its first heading
  documents: { file: string; start: number; heading: string | null }[];
};

// The nav document is read like any other, because some books keep their text in it too; what it
// holds outside its <nav> is usually only a "Contents" heading, and that much is dropped.
function readStream(spine: ManifestItem[], text: (name: string) => string | null, targets: Set<string>, navFile: string | null): Stream {
  const stream: Stream = { blocks: [], marks: new Map(), documents: [] };
  for (const item of spine) {
    const markup = text(item.href);
    if (!markup) continue;
    const doc = parseXhtml(markup);
    const [body] = doc.getElementsByTagName("body");
    const root = body ?? doc.documentElement;
    if (!root) continue;
    const start = stream.blocks.length;
    if (!stream.marks.has(item.href)) stream.marks.set(item.href, start);
    const heading = descendants(root).find((el) => HEADING_TAGS.has(localName(el)));
    stream.documents.push({ file: item.href, start, heading: cleanLabel(heading?.textContent) || null });
    walkDocument(root, item.href, targets, stream);
    if (item.href === navFile && wordCount(stream.blocks.slice(start)) < FRONT_MATTER_WORDS) {
      stream.blocks.length = start;
      stream.documents.pop();
    }
  }
  return stream;
}

function walkDocument(root: DomElement, file: string, targets: Set<string>, stream: Stream) {
  let buffer = "";
  let headingDepth = 0;

  const flush = () => {
    const paragraph = buffer
      .split("\n")
      .map((line) => line.replace(/[­​⁠﻿]/g, "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    buffer = "";
    if (!paragraph) return;
    if (headingDepth === 0 && PAGE_NUMBER.test(paragraph)) return;
    stream.blocks.push(paragraph);
  };

  const walk = (node: DomNode) => {
    if (node.nodeType === 3) {
      buffer += (node.nodeValue ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as DomElement;
    const tag = localName(el);

    const id = el.getAttribute("id");
    if (id && targets.has(`${file}#${id}`) && !stream.marks.has(`${file}#${id}`)) {
      flush();
      stream.marks.set(`${file}#${id}`, stream.blocks.length);
    }

    if (SKIP_TAGS.has(tag)) return;
    if (tokens(el, "epub:type").some((t) => SKIP_EPUB_TYPES.has(t))) return;
    if (tokens(el, "role").some((t) => SKIP_ROLES.has(t))) return;
    if (tag === "a" && (el.getAttribute("href") ?? "").includes("#") && NOTE_MARKER.test(el.textContent ?? "")) return;
    if (tag === "br") {
      buffer += "\n";
      return;
    }

    const block = BLOCK_TAGS.has(tag);
    const heading = HEADING_TAGS.has(tag);
    if (block) flush();
    if (heading) headingDepth++;
    for (const child of el.childNodes) walk(child);
    if (block) flush();
    if (heading) headingDepth--;
  };

  walk(root);
  flush();
}

type Boundary = { title: string; start: number };

function wordCount(blocks: string[]): number {
  return blocks.reduce((sum, b) => sum + b.split(/\s+/).filter(Boolean).length, 0);
}

function entryStart(entry: TocEntry, stream: Stream): number | null {
  if (!entry.target) return null;
  return stream.marks.get(entry.target) ?? stream.marks.get(entry.target.split("#")[0] ?? "") ?? null;
}

function fileOf(target: string | null): string | null {
  return target ? (target.split("#")[0] ?? null) : null;
}

// One table-of-contents level is the chapter level, and it differs per book. A part whose chapters
// live in files of their own and whose own page is short is opened into those chapters; a chapter
// whose sections are anchors in its own file stays one chapter.
function tocBoundaries(toc: TocEntry[], stream: Stream): Boundary[] {
  const out: Boundary[] = [];
  const visit = (entries: TocEntry[]) => {
    for (const entry of entries) {
      const start = entryStart(entry, stream);
      const [firstChild] = entry.children;
      if (!firstChild) {
        if (start !== null) out.push({ title: entry.title, start });
        continue;
      }
      if (start === null) {
        visit(entry.children);
        continue;
      }
      const childStart = entryStart(firstChild, stream);
      const ownFile = fileOf(entry.target);
      const separateFiles = entry.children.some((c) => fileOf(c.target) !== ownFile);
      const lead = childStart !== null ? stream.blocks.slice(start, childStart) : [];
      out.push({ title: entry.title, start });
      if (separateFiles && wordCount(lead) < PART_LEAD_WORDS) visit(entry.children);
    }
  };
  visit(toc);

  // Out-of-order entries cannot be sliced; at one position the later, more specific entry names it
  const sorted = out.map((b, order) => ({ ...b, order })).sort((a, b) => a.start - b.start || a.order - b.order);
  const deduped: Boundary[] = [];
  for (const b of sorted) {
    const last = deduped.at(-1);
    if (last && last.start === b.start) deduped[deduped.length - 1] = { title: b.title || last.title, start: b.start };
    else deduped.push({ title: b.title, start: b.start });
  }
  return deduped;
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function sliceChapters(stream: Stream, boundaries: Boundary[]): { title: string; text: string }[] {
  const pieces: { title: string; blocks: string[] }[] = [];
  const [first] = boundaries;
  if (first && wordCount(stream.blocks.slice(0, first.start)) >= FRONT_MATTER_WORDS) {
    pieces.push({ title: "Front matter", blocks: stream.blocks.slice(0, first.start) });
  }
  boundaries.forEach((b, i) => {
    const end = boundaries[i + 1]?.start ?? stream.blocks.length;
    pieces.push({ title: b.title, blocks: stream.blocks.slice(b.start, end) });
  });
  const titles = boundaries.map((b) => comparable(b.title)).filter((t) => t.length >= 4);
  return finishChapters(pieces.map((p) => (isContentsList(p.blocks, titles) ? { ...p, blocks: [] } : p)));
}

// A contents page printed as body text (Gutenberg does this): most of its lines are chapter titles
function isContentsList(blocks: string[], titles: string[]): boolean {
  const listed = blocks.filter((block) => {
    const key = comparable(block);
    return titles.some((title) => key.startsWith(title));
  }).length;
  return listed >= 3 && listed >= blocks.length / 2;
}

// No usable table of contents: every document in the reading order is a chapter
function documentChapters(stream: Stream): { title: string; text: string }[] {
  return finishChapters(stream.documents.map((doc, i) => ({
    title: doc.heading ?? `Part ${i + 1}`,
    blocks: stream.blocks.slice(doc.start, stream.documents[i + 1]?.start ?? stream.blocks.length),
  })));
}

// An empty piece (a cover image) is dropped. A piece holding nothing but its own title (a part's
// title page) is spoken at the start of the chapter after it rather than being a chapter of its own.
function finishChapters(pieces: { title: string; blocks: string[] }[]): { title: string; text: string }[] {
  const chapters: { title: string; text: string }[] = [];
  let carried: string[] = [];
  for (const piece of pieces) {
    const blocks = [...carried, ...piece.blocks];
    const title = (piece.title || blocks[0] || "").slice(0, 200).trim() || `Part ${chapters.length + 1}`;
    if (piece.blocks.length === 0 || comparable(piece.blocks.join(" ")) === comparable(piece.title)) {
      carried = blocks;
      continue;
    }
    carried = [];
    chapters.push({ title, text: blocks.join("\n\n") });
  }
  return chapters;
}
