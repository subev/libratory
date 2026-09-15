// Captures everything the AI OCR placement chain consumes for one file into a fixture directory,
// so the whole chain — alignment, layout, page joins, the text layer, geometry, the reader's
// rects — can be tested on a real book with no PDF, no OCR binary and no model call:
//
//   pnpm --filter @libratory/server exec tsx src/scripts/capture-ocr-fixture.ts <pdf> <outDir> <fixtureDir> [--language bg]
//
// <outDir> is the file's outDir holding llm-pages.json (the model's pages as read). Writes
// pages.json, sizes.json (page sizes in points), vision/pg-NN.tsv (Apple Vision, macOS) and
// tesseract/pg-NN.tsv per page. Fixtures of published books belong in test/fixtures/private/,
// which is gitignored; the tests skip when it is absent.
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { LLM_PAGE_EDGE, LLM_PAGES_FILE } from "../lib/ocr-llm.ts";
import { pdfPageSizes } from "../lib/ocr-tesseract.ts";
import { visionBinary, visionLanguage } from "../lib/ocr-vision.ts";
import { tesseractLanguage } from "../lib/tesseract-languages.ts";
import { ensureTessdata, tesseractEnv } from "../lib/tessdata.ts";

const execFileAsync = promisify(execFile);
const [pdf, outDir, fixtureDir] = process.argv.slice(2);
if (!pdf || !outDir || !fixtureDir) {
  console.error("usage: capture-ocr-fixture.ts <pdf> <outDir> <fixtureDir> [--language xx]");
  process.exit(2);
}
const languageAt = process.argv.indexOf("--language");
const language = languageAt === -1 ? null : process.argv[languageAt + 1] ?? null;

const sizes = await pdfPageSizes(pdf);
await mkdir(path.join(fixtureDir, "vision"), { recursive: true });
await mkdir(path.join(fixtureDir, "tesseract"), { recursive: true });
await copyFile(path.join(outDir, LLM_PAGES_FILE), path.join(fixtureDir, "pages.json"));
await writeFile(path.join(fixtureDir, "sizes.json"), JSON.stringify(sizes));

const work = await mkdtemp(path.join(tmpdir(), "capture-"));
try {
  await execFileAsync("pdftoppm", ["-scale-to", String(LLM_PAGE_EDGE), "-jpeg", "-jpegopt", "quality=85", "-gray", pdf, path.join(work, "pg")], { timeout: 600_000 });
  const images = (await readdir(work)).filter((f) => f.endsWith(".jpg")).sort();
  await ensureTessdata();
  const pack = tesseractLanguage(language).pack;
  const binary = await visionBinary();
  const vision = binary ? visionLanguage(language, null) : null;
  for (const [i, image] of images.entries()) {
    const name = `pg-${String(i + 1).padStart(2, "0")}.tsv`;
    const { stdout: tsv } = await execFileAsync("tesseract", [path.join(work, image), "-", "-l", pack, "tsv"], { env: tesseractEnv(), maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path.join(fixtureDir, "tesseract", name), tsv);
    if (binary && vision) {
      const { stdout: table } = await execFileAsync(binary, [path.join(work, image), vision.code], { maxBuffer: 64 * 1024 * 1024 });
      await writeFile(path.join(fixtureDir, "vision", name), table);
    }
    console.error(`page ${i + 1}/${images.length}`);
  }
  await writeFile(path.join(fixtureDir, "README.md"), `Captured by capture-ocr-fixture.ts from ${path.basename(pdf)} on ${new Date().toISOString().slice(0, 10)}: language ${language ?? "unset"}, Tesseract ${pack}${vision ? `, Vision ${vision.code}` : ""}, ${images.length} pages at ${LLM_PAGE_EDGE} px.\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.error(`written to ${fixtureDir}`);
