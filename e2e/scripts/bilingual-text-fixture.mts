import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachTextReaderLayer } from "../../packages/server/src/lib/epub-reader-layer.ts";
import { readBilingualDocument } from "../../packages/server/src/lib/bilingual-format.ts";
import type { P2afLayer } from "../../packages/server/src/lib/p2af.ts";

const exec = promisify(execFile);
const output = fileURLToPath(new URL("../fixtures/tiny-book-bilingual-text.epub", import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), "bilingual-text-fixture-"));
try {
  const doc = readBilingualDocument(JSON.parse(await readFile(new URL("../../packages/server/src/lib/fixtures/bilingual.json", import.meta.url), "utf8")));
  doc.chapterId = "paired";
  doc.source.narration = null; doc.target.narration = null;
  const texts = [{ id: "paired", title: "A paired sentence", text: doc.source.text }, { id: "plain", title: "An ordinary chapter", text: "A new paragraph.\n\nשָׁלוֹם world." }];
  const layer: P2afLayer = {
    manifest: { format: "p2af/1", book: { id: "bilingual-text-fixture", title: "Bilingual text fixture", author: null, language: "en", medianBodyPt: null, cover: null }, sources: [], pages: [],
      chapters: texts.map((text, i) => ({ id: text.id, i, title: text.title, text: `text/${text.id}.json`, audio: null, cues: null, durationMs: null, pageStart: null, pageEnd: null, mode: "text", why: "generated", bilingual: i === 0 ? [{ key: doc.key, language: doc.target.language, url: "bilingual/he.json" }] : [] })) },
    cues: [], sources: [], texts: texts.map((text) => ({ path: `text/${text.id}.json`, doc: { format: "p2af/1", text: text.text } })),
    bilingual: [{ path: "bilingual/he.json", doc, audio: [] }],
  };
  await mkdir(path.join(dir, "META-INF")); await mkdir(path.join(dir, "EPUB"));
  await writeFile(path.join(dir, "mimetype"), "application/epub+zip");
  await writeFile(path.join(dir, "META-INF/container.xml"), '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  await writeFile(path.join(dir, "EPUB/content.opf"), `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">bilingual-text-fixture</dc:identifier><dc:title>Bilingual text fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-28T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${texts.map((text) => `<item id="${text.id}" href="${text.id}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${texts.map((text) => `<itemref idref="${text.id}"/>`).join("")}</spine></package>`);
  await writeFile(path.join(dir, "EPUB/nav.xhtml"), `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${texts.map((text) => `<li><a href="${text.id}.xhtml">${text.title}</a></li>`).join("")}</ol></nav></body></html>`);
  for (const text of texts) await writeFile(path.join(dir, `EPUB/${text.id}.xhtml`), `<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${text.title}</title></head><body><h1>${text.title}</h1>${text.text.split("\n\n").map((paragraph) => `<p>${paragraph}</p>`).join("")}</body></html>`);
  await rm(output, { force: true });
  await exec("zip", ["-X", "-q", "-0", output, "mimetype"], { cwd: dir });
  await exec("zip", ["-X", "-q", "-9", "-r", output, "META-INF", "EPUB"], { cwd: dir });
  await attachTextReaderLayer(output, dir, layer);
  console.log(output);
} finally { await rm(dir, { recursive: true, force: true }); }
