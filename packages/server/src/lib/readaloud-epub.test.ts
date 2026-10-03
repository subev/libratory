import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { attachReaderLayer } from "./epub-reader-layer.ts";
import type { P2afLayer } from "./p2af.ts";
import { buildReadaloudEpub, languageCode } from "./readaloud-epub.ts";
import { bookOutputDir } from "./paths.ts";
import type { SyncMap } from "./sync-map.ts";
import { readBilingualDocument, textRevision } from "./bilingual-format.ts";
import bilingualFixture from "./fixtures/bilingual.json";

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

  it.each([[false, false], [true, false], [false, true], [true, true]])("attaches exactly the chosen recordings to bilingual EPUB: %s / %s", async (sourceAudio, targetAudio) => {
    const base = path.join(baseDir, "plain");
    await mkdir(path.join(base, "META-INF"), { recursive: true });
    await mkdir(path.join(base, "EPUB"), { recursive: true });
    await writeFile(path.join(base, "mimetype"), "application/epub+zip");
    await writeFile(path.join(base, "META-INF/container.xml"), '<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>');
    await writeFile(path.join(base, "EPUB/package.opf"), '<package><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>');
    await writeFile(path.join(base, "EPUB/chapter.xhtml"), "<html><body>Original text</body></html>");
    await execFileAsync("zip", ["-X", "-q", "-0", outputPath, "mimetype"], { cwd: base });
    await execFileAsync("zip", ["-X", "-q", "-r", outputPath, "META-INF", "EPUB"], { cwd: base });
    const doc = readBilingualDocument(bilingualFixture);
    const audio: NonNullable<P2afLayer["bilingual"]>[number]["audio"] = [];
    for (const [side, enabled] of [["source", sourceAudio], ["target", targetAudio]] as const) {
      const narration = doc[side].narration;
      if (!narration) throw new Error("Fixture narration missing");
      if (!enabled) { doc[side].narration = null; continue; }
      const file = path.join(base, `${side}.m4a`);
      await writeFile(file, side);
      narration.audio = `audio/${side}.m4a`;
      narration.revision = textRevision(side);
      audio.push({ path: narration.audio, sourcePath: file, mediaType: "audio/mp4" });
    }
    const layer: P2afLayer = {
      manifest: { format: "p2af/1", book: { id: "chosen", title: "Chosen", author: null, language: "en", cover: null, medianBodyPt: null }, sources: [], pages: [],
        chapters: [{ id: doc.chapterId, i: 0, title: "Example", text: "text/source.json", audio: doc.source.narration?.audio ?? null,
          cues: null, durationMs: doc.source.narration?.totalMs ?? null, pageStart: null, pageEnd: null, mode: "text",
          bilingual: [{ key: doc.key, language: doc.target.language, url: "bilingual/selected.json" }] }] },
      cues: [], sources: [], texts: [{ path: "text/source.json", doc: { format: "p2af/1", text: doc.source.text } }],
      bilingual: [{ path: "bilingual/selected.json", doc, audio }],
    };
    await attachReaderLayer(outputPath, path.join(baseDir, "attach"), layer);
    const opf = await zipEntry(outputPath, "EPUB/package.opf");
    expect(opf.includes('href="p2af/audio/source.m4a"')).toBe(sourceAudio);
    expect(opf.includes('href="p2af/audio/target.m4a"')).toBe(targetAudio);
    const { stdout } = await execFileAsync("unzip", ["-v", outputPath]);
    for (const [side, enabled] of [["source", sourceAudio], ["target", targetAudio]] as const) {
      const line = stdout.split("\n").find((line) => line.includes(`p2af/audio/${side}.m4a`));
      if (enabled) expect(line).toContain("Stored"); else expect(line).toBeUndefined();
    }
    expect(readBilingualDocument(JSON.parse(await zipEntry(outputPath, "EPUB/p2af/bilingual/selected.json")))).toEqual(doc);
  });

  it.each([null, "text", "recording", "clock"] as const)("packages bilingual data only when its chapter and recording match (%s)", async (fault) => {
    await mkdir(baseDir, { recursive: true });
    const primary = path.join(baseDir, "primary.m4a"), secondary = path.join(baseDir, "secondary.m4a");
    await writeFile(primary, "primary recording");
    await writeFile(secondary, "secondary recording");
    const doc = readBilingualDocument(bilingualFixture);
    if (!doc.source.narration || !doc.target.narration) throw new Error("Missing fixture narration");
    doc.source.narration.revision = textRevision("primary recording");
    doc.target.narration.revision = textRevision("secondary recording");
    if (fault === "recording") doc.target.narration.revision = "0".repeat(64);
    if (fault === "clock") doc.source.narration.audio = doc.target.narration.audio;
    const build = () => buildReadaloudEpub({
      title: "Bilingual fixture", language: "en", stagingDir: path.join(baseDir, "staging"), outputPath,
      chapters: [{ id: doc.chapterId, index: 0, title: "Example", audioPath: primary, sync: sync([doc.source.text], 2000) }],
      p2af: async () => ({
        manifest: { format: "p2af/1", book: { id: "book", title: "Example", author: null, language: "en", cover: null, medianBodyPt: null }, sources: [], pages: [], chapters: [{ id: doc.chapterId, i: 0, title: "Example", audio: "../audio/ch000.m4a", cues: "cues/ch000.json", text: null, durationMs: 2000, pageStart: null, pageEnd: null, mode: "text", bilingual: [{ key: "he", language: "he", url: "bilingual/he.json" }] }] },
        sources: [], cues: [{ path: "cues/ch000.json", doc: { format: "p2af/1", totalMs: 2000, granularity: "sentence", text: { format: "p2af/1", text: fault === "text" ? "A newer chapter revision" : doc.source.text }, cues: [] } }], bilingual: [{ path: "bilingual/he.json", doc, audio: [{ path: "audio/he.m4a", sourcePath: secondary, mediaType: "audio/mp4" }] }],
      }),
    });
    if (fault) {
      await expect(build()).rejects.toThrow(fault === "text" ? "source text differs" : fault === "clock" ? "source recording differs" : "recording revision differs");
      return;
    }
    await build();
    const opf = await zipEntry(outputPath, "OEBPS/package.opf");
    expect(opf).toContain('href="p2af/bilingual/he.json" media-type="application/json"');
    expect(opf).toContain('href="p2af/audio/he.m4a" media-type="audio/mp4"');
    expect(opf).not.toContain('<itemref idref="p2af_bilingual');
    expect(await zipEntry(outputPath, "OEBPS/p2af/audio/he.m4a")).toBe("secondary recording");
    expect(await zipEntry(outputPath, "OEBPS/audio/ch000.m4a")).toBe("primary recording");
    expect(readBilingualDocument(JSON.parse(await zipEntry(outputPath, "OEBPS/p2af/bilingual/he.json")))).toEqual(doc);
    const { stdout } = await execFileAsync("unzip", ["-v", outputPath]);
    expect(stdout.split("\n").find((line) => line.includes("p2af/audio/he.m4a"))).toContain("Stored");
  });
});
