import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { EpubImportError, parseEpub } from "./epub-import.ts";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>ignored head title</title><style>p { margin: 0 }</style></head>
<body>${body}</body></html>`;
}

type Doc = { id: string; href: string; body?: string; raw?: string; linear?: boolean; nav?: boolean };

function makeEpub(opts: {
  docs: Doc[];
  metadata?: string;
  ncx?: string;
  extra?: Record<string, string>;
}): Uint8Array {
  const manifest = opts.docs
    .map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"${d.nav ? ' properties="nav"' : ""}/>`)
    .join("\n");
  const spine = opts.docs
    .map((d) => `<itemref idref="${d.id}"${d.linear === false ? ' linear="no"' : ""}/>`)
    .join("\n");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${opts.metadata ?? '<dc:title>Test Book</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en-GB</dc:language>'}
  </metadata>
  <manifest>
    ${manifest}
    ${opts.ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine${opts.ncx ? ' toc="ncx"' : ""}>${spine}</spine>
</package>`;
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(CONTAINER),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/images/cover.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  };
  for (const d of opts.docs) files[`OEBPS/${d.href}`] = strToU8(d.raw ?? xhtml(d.body ?? ""));
  if (opts.ncx) files["OEBPS/toc.ncx"] = strToU8(opts.ncx);
  for (const [name, content] of Object.entries(opts.extra ?? {})) files[name] = strToU8(content);
  return zipSync(files);
}

const words = (n: number, word = "lorem") => Array.from({ length: n }, () => word).join(" ");

describe("parseEpub", () => {
  // The shape trade publishers ship: parts in files of their own, chapters in theirs, a nav document
  // holding the page list and landmarks beside the table of contents, and print page numbers kept.
  const partsBook = makeEpub({
    docs: [
      { id: "cover", href: "cover.xhtml", body: '<div><img src="images/cover.jpg" alt="Cover"/></div>' },
      {
        id: "nav", href: "nav.xhtml", nav: true,
        raw: xhtml(`<h1>Contents</h1>
          <nav epub:type="toc"><ol>
            <li><a href="cover.xhtml">Cover</a></li>
            <li><a href="part1.xhtml">Part One</a><ol>
              <li><a href="ch1.xhtml">Chapter 1: Arrival</a></li>
              <li><a href="ch2.xhtml#start">Chapter 2: Departure</a></li>
            </ol></li>
            <li><a href="notes.xhtml">Notes</a></li>
          </ol></nav>
          <nav epub:type="page-list"><ol>
            <li><a href="ch1.xhtml#p1">1</a></li><li><a href="ch1.xhtml#p2">2</a></li><li><a href="ch2.xhtml#p3">3</a></li>
          </ol></nav>
          <nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="ch1.xhtml">Start</a></li></ol></nav>`),
      },
      { id: "part1", href: "part1.xhtml", body: '<section epub:type="part"><h1>Part One</h1></section>' },
      {
        id: "ch1", href: "ch1.xhtml",
        body: `<h2>Chapter 1: Arrival</h2>
          <p>It was a dark&nbsp;night<span epub:type="pagebreak" id="p1" title="1"/> and the rain fell.</p>
          <p class="pagenum">2</p>
          <p>She read the letter<a epub:type="noteref" href="notes.xhtml#n1">1</a> twice, then a third time<a href="notes.xhtml#n2"><sup>[2]</sup></a>.</p>
          <span role="doc-pagebreak" id="p2">2</span>
          <p>The ex­traordinary house stood&#8212;silent.<br/>A second line.</p>
          <aside epub:type="footnote"><p>A footnote that is not read.</p></aside>
          <p>xii</p>`,
      },
      {
        id: "ch2", href: "ch2.xhtml",
        body: `<div id="start"><h2>Chapter 2: Departure</h2>
          <p>They left at dawn<span epub:type="pagebreak" id="p3">3</span> without a word.</p></div>`,
      },
      {
        id: "notes", href: "notes.xhtml",
        body: '<section epub:type="endnotes"><h2>Notes</h2><ol><li id="n1">A note.</li><li id="n2">Another.</li></ol></section>',
      },
    ],
  });

  it("names chapters from the table of contents, opening parts into their chapters", () => {
    const book = parseEpub(partsBook);
    expect(book.chapters.map((c) => c.title)).toEqual(["Chapter 1: Arrival", "Chapter 2: Departure"]);
  });

  it("reads the book's metadata", () => {
    expect(parseEpub(partsBook)).toMatchObject({ title: "Test Book", author: "A. Writer", language: "en-GB" });
  });

  it("speaks a part's title page at the start of its first chapter", () => {
    const [first] = parseEpub(partsBook).chapters;
    expect(first?.text.startsWith("Part One\n\nChapter 1: Arrival\n\n")).toBe(true);
  });

  it("strips printed page numbers, note markers and notes, keeping the prose", () => {
    const [first, second] = parseEpub(partsBook).chapters;
    expect(first?.text).toBe([
      "Part One",
      "Chapter 1: Arrival",
      "It was a dark night and the rain fell.",
      "She read the letter twice, then a third time.",
      "The extraordinary house stood—silent.\nA second line.",
    ].join("\n\n"));
    expect(second?.text).toBe("Chapter 2: Departure\n\nThey left at dawn without a word.");
  });

  it("never reads the contents page, the page list or the cover aloud", () => {
    const all = parseEpub(partsBook).chapters.map((c) => c.text).join("\n");
    expect(all).not.toContain("Contents");
    expect(all).not.toContain("Start");
    expect(all).not.toContain("Cover");
    expect(all).not.toContain("A note.");
  });

  it("cuts chapters at anchors inside one file, from an EPUB 2 NCX, and keeps substantial front matter", () => {
    const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="a" playOrder="1"><navLabel><text>One</text></navLabel><content src="book.xhtml#c1"/></navPoint>
  <navPoint id="b" playOrder="2"><navLabel><text>Two</text></navLabel><content src="book.xhtml#c2"/></navPoint>
  <navPoint id="c" playOrder="3"><navLabel><text>Three</text></navLabel><content src="book%20end.xhtml"/></navPoint>
</navMap></ncx>`;
    const book = parseEpub(makeEpub({
      ncx,
      docs: [
        {
          id: "book", href: "book.xhtml",
          body: `<p>${words(60, "preface")}</p>
            <h2 id="c1">One</h2><p>First body.</p>
            <p>More of the first.<a id="c2"/>Second body starts mid-paragraph.</p>`,
        },
        { id: "end", href: "book end.xhtml", body: "<h2>Three</h2><p>Third body.</p>" },
      ],
    }));
    expect(book.chapters.map((c) => c.title)).toEqual(["Front matter", "One", "Two", "Three"]);
    expect(book.chapters[1]?.text).toBe("One\n\nFirst body.\n\nMore of the first.");
    expect(book.chapters[2]?.text).toBe("Second body starts mid-paragraph.");
    expect(book.chapters[3]?.text).toBe("Three\n\nThird body.");
  });

  it("keeps a chapter whole when its sections are anchors in its own file", () => {
    const book = parseEpub(makeEpub({
      docs: [
        {
          id: "nav", href: "nav.xhtml", nav: true,
          raw: xhtml(`<nav epub:type="toc"><ol>
            <li><a href="a.xhtml">Alpha</a><ol><li><a href="a.xhtml#s1">Alpha section</a></li></ol></li>
            <li><a href="b.xhtml">Beta</a></li>
          </ol></nav>`),
        },
        { id: "a", href: "a.xhtml", body: '<h1>Alpha</h1><p>Intro.</p><h2 id="s1">Alpha section</h2><p>Section text.</p>' },
        { id: "b", href: "b.xhtml", body: "<h1>Beta</h1><p>Beta text.</p>" },
      ],
    }));
    expect(book.chapters.map((c) => c.title)).toEqual(["Alpha", "Beta"]);
    expect(book.chapters[0]?.text).toContain("Section text.");
  });

  it("falls back to one chapter per document when there is no usable table of contents", () => {
    const book = parseEpub(makeEpub({
      docs: [
        { id: "a", href: "a.xhtml", body: "<h1>Opening</h1><p>First.</p>" },
        { id: "b", href: "b.xhtml", body: "<p>Untitled second.</p>" },
        { id: "aside", href: "popup.xhtml", body: "<p>Auxiliary content.</p>", linear: false },
      ],
    }));
    expect(book.chapters).toEqual([
      { title: "Opening", text: "Opening\n\nFirst." },
      { title: "Part 2", text: "Untitled second." },
    ]);
  });

  it("reads a book whose only document is also its nav document", () => {
    const book = parseEpub(makeEpub({
      docs: [{
        id: "only", href: "only.xhtml", nav: true,
        raw: xhtml(`<nav epub:type="toc"><ol><li><a href="#a">First</a></li><li><a href="#b">Second</a></li></ol></nav>
          <section id="a"><h1>First</h1><p>${words(40)}</p></section>
          <section id="b"><h1>Second</h1><p>${words(40)}</p></section>`),
      }],
    }));
    expect(book.chapters.map((c) => c.title)).toEqual(["First", "Second"]);
  });

  it("drops a contents page printed as body text", () => {
    const book = parseEpub(makeEpub({
      docs: [
        {
          id: "nav", href: "nav.xhtml", nav: true,
          raw: xhtml(`<nav epub:type="toc"><ol>
            <li><a href="text.xhtml#toc">Contents</a></li>
            <li><a href="text.xhtml#c1">CHAPTER I. The Harbour</a></li>
            <li><a href="text.xhtml#c2">CHAPTER II. The Hill</a></li>
            <li><a href="text.xhtml#c3">CHAPTER III. The House[1]</a></li>
          </ol></nav>`),
        },
        {
          id: "text", href: "text.xhtml",
          body: `<h2 id="toc">Contents</h2>
            <p>CHAPTER I. The Harbour</p><p>CHAPTER II. The Hill</p><p>CHAPTER III. The House</p>
            <h2 id="c1">CHAPTER I. The Harbour</h2><p>Boats.</p>
            <h2 id="c2">CHAPTER II. The Hill</h2><p>Grass.</p>
            <h2 id="c3">CHAPTER III. The House</h2><p>Walls.</p>`,
        },
      ],
    }));
    expect(book.chapters.map((c) => c.title)).toEqual(["CHAPTER I. The Harbour", "CHAPTER II. The Hill", "CHAPTER III. The House"]);
  });

  it("refuses a DRM-protected EPUB by name", () => {
    const epub = makeEpub({
      docs: [{ id: "a", href: "a.xhtml", body: "<p>scrambled</p>" }],
      extra: {
        "META-INF/encryption.xml": `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/a.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`,
      },
    });
    expect(() => parseEpub(epub)).toThrow(/DRM-protected/);
  });

  it("imports a DRM-free EPUB whose fonts are obfuscated", () => {
    const epub = makeEpub({
      docs: [{ id: "a", href: "a.xhtml", body: "<h1>Only</h1><p>Readable.</p>" }],
      extra: {
        "META-INF/encryption.xml": `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
          <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/serif.otf"/></enc:CipherData></enc:EncryptedData></encryption>`,
      },
    });
    expect(parseEpub(epub).chapters).toEqual([{ title: "Only", text: "Only\n\nReadable." }]);
  });

  it("refuses a file that is not an EPUB", () => {
    expect(() => parseEpub(strToU8("%PDF-1.4 not a zip"))).toThrow(EpubImportError);
    expect(() => parseEpub(zipSync({ "readme.txt": strToU8("hello") }))).toThrow(/no package file/);
  });
});
