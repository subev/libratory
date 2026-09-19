import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { buildReadaloudEpub, languageCode } from "./readaloud-epub.ts";
import { bookOutputDir } from "./paths.ts";
import type { SyncMap } from "./sync-map.ts";

const execFileAsync = promisify(execFile);

async function zipEntry(epubPath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync("unzip", ["-p", epubPath, entry]);
  return stdout;
}

describe("languageCode", () => {
  it("passes an ISO code through, which is what the book row holds now", () => {
    expect(languageCode("en")).toBe("en");
    expect(languageCode("bg")).toBe("bg");
    expect(languageCode("pt-BR")).toBe("pt-br");
  });

  it("still translates the names older rows were written with", () => {
    expect(languageCode("Bulgarian")).toBe("bg");
  });

  it("says nothing rather than guessing at something that is not a language", () => {
    expect(languageCode("gibberish text")).toBe("und");
  });
});

describe("languageCode", () => {
  it("maps known names, defaults original to en and unknown to und", () => {
    expect(languageCode("Bulgarian")).toBe("bg");
    expect(languageCode(null)).toBe("en");
    expect(languageCode("Klingon")).toBe("und");
  });
});

describe("buildReadaloudEpub", () => {
  const bookId = `test-book-${crypto.randomUUID()}`;
  const baseDir = bookOutputDir(bookId);
  const outputPath = path.join(baseDir, "book.epub");

  const sync = (texts: string[], chunkMs: number): SyncMap => ({
    version: 1,
    totalMs: texts.length * chunkMs,
    chunks: texts.map((text, i) => ({ text, startMs: i * chunkMs, endMs: (i + 1) * chunkMs })),
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("produces a valid EPUB skeleton with media overlays", async () => {
    await mkdir(baseDir, { recursive: true });
    // One legacy MP3 chapter and one AAC chapter — both must carry their own media type
    const mp3a = path.join(baseDir, "ch000-src.mp3");
    const m4ab = path.join(baseDir, "ch001-src.m4a");
    await writeFile(mp3a, "fake-mp3-a");
    await writeFile(m4ab, "fake-m4a-b");

    await buildReadaloudEpub({
      title: "Fish & Chips",
      language: "Bulgarian",
      chapters: [
        { id: "ch-0", index: 0, title: "Intro <1>", audioPath: mp3a, sync: sync(["Здравей & добре дошъл.", "Втора част."], 1500) },
        { id: "ch-1", index: 1, title: "Chapter Two", audioPath: m4ab, sync: sync(["More text."], 2000), link: "https://www.example.com/a?b=1&c=\"2\"" },
      ],
      stagingDir: path.join(baseDir, "staging"),
      outputPath,
    });

    expect(await zipEntry(outputPath, "mimetype")).toBe("application/epub+zip");

    // mimetype must be the first entry in the archive
    const { stdout: listing } = await execFileAsync("unzip", ["-l", outputPath]);
    const firstEntry = listing.split("\n").find((l) => /\d+\s+[\d-]+/.test(l));
    expect(firstEntry).toContain("mimetype");

    const container = await zipEntry(outputPath, "META-INF/container.xml");
    expect(container).toContain('full-path="OEBPS/package.opf"');

    const opf = await zipEntry(outputPath, "OEBPS/package.opf");
    expect(opf).toContain('<dc:title id="title">Fish &amp; Chips</dc:title>');
    expect(opf).toContain("<dc:language>bg</dc:language>");
    expect(opf).toContain('media-overlay="ch000_overlay"');
    expect(opf).toContain('<meta property="media:duration" refines="#ch000_overlay">0:00:03.000</meta>');
    expect(opf).toContain('<meta property="media:duration">0:00:05.000</meta>');
    expect(opf).toContain('<meta property="media:active-class">-epub-media-overlay-active</meta>');
    expect(opf).toContain('<itemref linear="yes" idref="titlepage"/>');
    expect(opf.trim()).toMatch(/<itemref linear="yes" idref="ch001"\/>\s*<\/spine>/);


    const xhtml = await zipEntry(outputPath, "OEBPS/ch000.xhtml");
    expect(xhtml).toContain("<h1>Intro &lt;1&gt;</h1>");
    expect(xhtml).toContain('<p><span id="ch000-s0">Здравей &amp; добре дошъл.</span></p>');
    expect(xhtml).toContain('xml:lang="bg"');

    // A chapter written from the web names where it came from; the overlay never reads it aloud
    expect(xhtml).not.toContain('class="source"');
    const linked = await zipEntry(outputPath, "OEBPS/ch001.xhtml");
    expect(linked).toContain('<p class="source"><a href="https://www.example.com/a?b=1&amp;c=&quot;2&quot;">example.com</a></p>');
    expect(await zipEntry(outputPath, "OEBPS/ch001_overlay.smil")).not.toContain("source");

    // No "../" anywhere in SMIL refs — flat layout like the IDPF sample
    const smil = await zipEntry(outputPath, "OEBPS/ch000_overlay.smil");
    expect(smil).toContain('epub:textref="ch000.xhtml"');
    expect(smil).toContain('epub:type="bodymatter chapter"');
    expect(smil).toContain('<text src="ch000.xhtml#ch000-s0"/>');
    expect(smil).toContain('<audio src="audio/ch000.mp3" clipBegin="0:00:00.000" clipEnd="0:00:01.500"/>');
    expect(smil).toContain('clipBegin="0:00:01.500" clipEnd="0:00:03.000"');
    expect(smil).not.toContain("../");

    expect(opf).toContain('<item id="audio_ch000" href="audio/ch000.mp3" media-type="audio/mpeg"/>');
    expect(opf).toContain('<item id="audio_ch001" href="audio/ch001.m4a" media-type="audio/mp4"/>');

    const smilB = await zipEntry(outputPath, "OEBPS/ch001_overlay.smil");
    expect(smilB).toContain('<audio src="audio/ch001.m4a"');

    expect(await zipEntry(outputPath, "OEBPS/audio/ch000.mp3")).toBe("fake-mp3-a");
    expect(await zipEntry(outputPath, "OEBPS/audio/ch001.m4a")).toBe("fake-m4a-b");

    const nav = await zipEntry(outputPath, "OEBPS/nav.xhtml");
    expect(nav).toContain('<a href="ch000.xhtml">Intro &lt;1&gt;</a>');
    expect(nav).toContain('<a href="ch001.xhtml">Chapter Two</a>');
  });
});
