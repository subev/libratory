import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SyncMap } from "./sync-map.ts";
import type { ExportedChapter, P2afLayer } from "./p2af.ts";
import { P2AF_DIR } from "./p2af.ts";
import { generateCover } from "./cover.ts";

const execFileAsync = promisify(execFile);

// Chapters synthesized before the AAC switch are .mp3; both are EPUB 3 core media types
const AUDIO_MEDIA_TYPES: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
};

function audioMediaType(ext: string): string {
  return AUDIO_MEDIA_TYPES[ext] ?? "audio/mpeg";
}

export type ReadaloudBook = { title: string; author: string | null; language: string | null };

export type ReadaloudChapter = {
  id: string;
  index: number;
  title: string;
  audioPath: string;
  sync: SyncMap;
  link?: string;
};


const LANGUAGE_CODES: Record<string, string> = {
  english: "en", bulgarian: "bg", german: "de", french: "fr", spanish: "es",
  italian: "it", portuguese: "pt", russian: "ru", greek: "el", romanian: "ro",
  polish: "pl", czech: "cs", dutch: "nl", hungarian: "hu", swedish: "sv",
  danish: "da", finnish: "fi", norwegian: "no", turkish: "tr", ukrainian: "uk",
  serbian: "sr", croatian: "hr", slovak: "sk", slovenian: "sl", macedonian: "mk",
};

// books.language holds an ISO code now and held a language's name before that, and only the names
// were ever translated — so every book that actually had a language set came out "und", while the
// ones that had none came out "en".
export function languageCode(language: string | null): string {
  if (!language) return "en";
  const value = language.trim().toLowerCase();
  if (LANGUAGE_CODES[value]) return LANGUAGE_CODES[value];
  return /^[a-z]{2,3}(-[a-z0-9]+)*$/.test(value) ? value : "und";
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Clock format as in the IDPF media-overlays sample (the shape reader apps are tested against)
function clock(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = Math.round(ms % 1000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

function chapterBase(seq: number): string {
  return `ch${String(seq).padStart(3, "0")}`;
}

// Layout mirrors the IDPF sample: XHTML and SMIL at the package root, audio in audio/ —
// SMIL audio refs never contain "../", which trips some readers' native path handling.
// The source link sits outside the overlay: no <par> names it, so it is shown and never spoken
function chapterXhtml(base: string, title: string, sync: SyncMap, lang: string, link?: string): string {
  const paragraphs = sync.chunks
    .map((c, i) => `    <p><span id="${base}-s${i}">${esc(c.text)}</span></p>`)
    .concat(link ? [`    <p class="source"><a href="${esc(link).replace(/"/g, "&quot;")}">${esc(linkLabel(link))}</a></p>`] : [])
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="css/style.css"/>
</head>
<body>
  <section epub:type="bodymatter chapter">
    <h1>${esc(title)}</h1>
${paragraphs}
  </section>
</body>
</html>
`;
}

function linkLabel(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return link;
  }
}

function chapterSmil(base: string, audioExt: string, sync: SyncMap): string {
  const pars = sync.chunks
    .map((c, i) => `      <par id="${base}-s${i}">
        <text src="${base}.xhtml#${base}-s${i}"/>
        <audio src="audio/${base}${audioExt}" clipBegin="${clock(c.startMs)}" clipEnd="${clock(c.endMs)}"/>
      </par>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body>
    <seq id="${base}_overlay_seq" epub:textref="${base}.xhtml" epub:type="bodymatter chapter">
${pars}
    </seq>
  </body>
</smil>
`;
}

function titlepageXhtml(title: string, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="css/style.css"/>
</head>
<body>
  <section epub:type="frontmatter titlepage">
    <h1>${esc(title)}</h1>
  </section>
</body>
</html>
`;
}

function navXhtml(title: string, chapters: { base: string; title: string }[], lang: string): string {
  const items = chapters
    .map((ch) => `      <li><a href="${ch.base}.xhtml">${esc(ch.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><title>${esc(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${esc(title)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

const STYLE_CSS = `body { font-family: serif; line-height: 1.6; margin: 1em; }
h1 { font-size: 1.4em; }
p { margin: 0 0 0.9em 0; }
.source { margin-top: 2em; font-size: 0.85em; }
.-epub-media-overlay-active {
  background-color: #ffb;
}
`;

function packageOpf(opts: {
  title: string;
  author: string | null;
  lang: string;
  hasCover: boolean;
  chapters: { base: string; title: string; audioExt: string; sync: SyncMap }[];
  p2af: P2afLayer | null;
}): string {
  const { title, author, lang, hasCover, chapters, p2af } = opts;
  const totalMs = chapters.reduce((sum, ch) => sum + ch.sync.totalMs, 0);
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const manifest = chapters
    .map((ch) => `    <item id="${ch.base}" href="${ch.base}.xhtml" media-type="application/xhtml+xml" media-overlay="${ch.base}_overlay"/>
    <item id="${ch.base}_overlay" href="${ch.base}_overlay.smil" media-type="application/smil+xml"/>
    <item id="audio_${ch.base}" href="audio/${ch.base}${ch.audioExt}" media-type="${audioMediaType(ch.audioExt)}"/>`)
    .join("\n");
  const durations = chapters
    .map((ch) => `    <meta property="media:duration" refines="#${ch.base}_overlay">${clock(ch.sync.totalMs)}</meta>`)
    .join("\n");
  const spine = chapters.map((ch) => `    <itemref linear="yes" idref="${ch.base}"/>`).join("\n");

  // Manifested but outside the spine: an EPUB reader never opens them, and a reader that knows
  // the p2af layer finds the pages here. The audio is the EPUB's own — one copy, two layers.
  const extras = p2af
    ? [
        `    <item id="p2af_book" href="${P2AF_DIR}/book.json" media-type="application/json"/>`,
        ...p2af.sources.map((src, i) => `    <item id="p2af_src_${i}" href="${P2AF_DIR}/${src.path}" media-type="application/pdf"/>`),
        ...p2af.cues.map((cue, i) => `    <item id="p2af_cues_${i}" href="${P2AF_DIR}/${cue.path}" media-type="application/json"/>`),
      ].join("\n")
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="${lang}" unique-identifier="uid" prefix="media: http://www.idpf.org/epub/vocab/overlays/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${randomUUID()}</dc:identifier>
    <dc:title id="title">${esc(title)}</dc:title>
    <meta refines="#title" property="title-type">main</meta>
${author ? `    <dc:creator id="creator">${esc(author)}</dc:creator>
    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>` : ""}
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
${durations}
    <meta property="media:duration">${clock(totalMs)}</meta>
    <meta property="media:active-class">-epub-media-overlay-active</meta>
  </metadata>
  <manifest>
    <item id="nav" properties="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
${hasCover ? `    <item id="cover-image" properties="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>\n` : ""}    <item id="style" href="css/style.css" media-type="text/css"/>
${manifest}
${extras}
  </manifest>
  <spine>
    <itemref linear="yes" idref="titlepage"/>
${spine}
  </spine>
</package>
`;
}

export async function buildReadaloudEpub(opts: {
  title: string;
  author?: string | null;
  language: string | null;
  chapters: ReadaloudChapter[];
  stagingDir: string;
  outputPath: string;
  // Given the names chosen here, returns the read-along layer to ride along. Inverted so this
  // file keeps owning the layout and stays free of the database.
  p2af?: (exported: Map<string, ExportedChapter>, cover: string | null) => Promise<P2afLayer | null>;
}): Promise<void> {
  const { title, author = null, language, chapters, stagingDir, outputPath } = opts;
  if (chapters.length === 0) throw new Error("No chapters to export");
  const lang = languageCode(language);

  const ordered = [...chapters].sort((a, b) => a.index - b.index);
  const named = ordered.map((ch, seq) => ({
    ...ch,
    base: chapterBase(seq),
    audioExt: path.extname(ch.audioPath).toLowerCase(),
  }));

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(path.join(stagingDir, "META-INF"), { recursive: true });
  for (const dir of ["audio", "css", "images"]) {
    await mkdir(path.join(stagingDir, "OEBPS", dir), { recursive: true });
  }

  const hasCover = await generateCover(path.join(stagingDir, "OEBPS", "images", "cover.jpg"), title);
  if (!hasCover) await rm(path.join(stagingDir, "OEBPS", "images"), { recursive: true, force: true });

  const exported = new Map<string, ExportedChapter>(
    named.map((ch) => [ch.id, { base: ch.base, audioFile: `${ch.base}${ch.audioExt}` }]),
  );
  const p2af = (await opts.p2af?.(exported, hasCover ? "../images/cover.jpg" : null)) ?? null;

  await writeFile(path.join(stagingDir, "mimetype"), "application/epub+zip");
  await writeFile(
    path.join(stagingDir, "META-INF", "container.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  );
  await writeFile(path.join(stagingDir, "OEBPS", "package.opf"), packageOpf({ title, author, lang, hasCover, chapters: named, p2af }));
  await writeFile(path.join(stagingDir, "OEBPS", "nav.xhtml"), navXhtml(title, named, lang));
  await writeFile(path.join(stagingDir, "OEBPS", "titlepage.xhtml"), titlepageXhtml(title, lang));
  await writeFile(path.join(stagingDir, "OEBPS", "css", "style.css"), STYLE_CSS);

  if (p2af) await writeP2afLayer(path.join(stagingDir, "OEBPS", P2AF_DIR), p2af);

  for (const ch of named) {
    await writeFile(path.join(stagingDir, "OEBPS", `${ch.base}.xhtml`), chapterXhtml(ch.base, ch.title, ch.sync, lang, ch.link));
    await writeFile(path.join(stagingDir, "OEBPS", `${ch.base}_overlay.smil`), chapterSmil(ch.base, ch.audioExt, ch.sync));
    await copyFile(ch.audioPath, path.join(stagingDir, "OEBPS", "audio", `${ch.base}${ch.audioExt}`));
  }

  // EPUB OCF: mimetype must be first and stored; audio is already compressed, so store it too
  await rm(outputPath, { force: true });
  const zipOpts = { cwd: stagingDir, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 };
  await execFileAsync("zip", ["-X", "-q", "-0", outputPath, "mimetype"], zipOpts);
  const storedDirs = ["OEBPS/audio", ...(p2af?.sources.length ? [`OEBPS/${P2AF_DIR}/source`] : [])];
  await execFileAsync(
    "zip",
    ["-X", "-q", "-9", "-r", outputPath, "META-INF", "OEBPS", ...storedDirs.flatMap((dir) => ["-x", `${dir}/*`])],
    zipOpts,
  );
  await execFileAsync("zip", ["-X", "-q", "-0", "-r", outputPath, ...storedDirs], zipOpts);
}

// The cues are the bulk of the layer and compress to about a quarter; the PDFs are already
// compressed and are stored, so a reader can hand their bytes straight to a PDF renderer.
async function writeP2afLayer(dir: string, layer: P2afLayer): Promise<void> {
  await mkdir(path.join(dir, "cues"), { recursive: true });
  if (layer.sources.length > 0) await mkdir(path.join(dir, "source"), { recursive: true });
  await writeFile(path.join(dir, "book.json"), JSON.stringify(layer.manifest));
  for (const cue of layer.cues) await writeFile(path.join(dir, cue.path), JSON.stringify(cue.doc));
  for (const source of layer.sources) await copyFile(source.pdfPath, path.join(dir, source.path));
}
