// Regenerates fixtures/scanned-page.pdf — one page of real prose with no text layer at all, which
// is the only kind of file the OCR step is allowed to touch. Rendered from the e2e booklet so the
// words are known, then wrapped as an image-only PDF by PIL, which is what a scanner produces.
// Run: node packages/server/test/fixtures/make-scanned-page.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const source = path.resolve(here, "../../../../e2e/fixtures/tiny-book.pdf");
const out = path.join(here, "scanned-page.pdf");
const work = mkdtempSync(path.join(tmpdir(), "scanned-page-"));

try {
  execFileSync("pdftoppm", ["-r", "150", "-png", "-gray", "-f", "1", "-l", "1", source, path.join(work, "pg")]);
  const png = path.join(work, "pg-1.png");
  execFileSync(path.resolve(here, "../../../../.venv/bin/python"), [
    "-c",
    `from PIL import Image; Image.open(${JSON.stringify(png)}).save(${JSON.stringify(out)}, "PDF")`,
  ]);
  console.log(`wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
