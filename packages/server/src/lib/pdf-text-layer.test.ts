import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { extractPdfRawText, pdfHasTextLayer } from "./pdf-raw-text.ts";
import { writeTextLayer } from "./pdf-text-layer.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../test/fixtures/scanned-page.pdf");
const execFileAsync = promisify(execFile);
const python = path.join(env.CONDA_ENV_PATH, "python");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("writeTextLayer", () => {
  it.skipIf(!existsSync(python))("bounds imported text rasterization even when phone scans use pixel-sized PDF pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "large-text-layer-"));
    dirs.push(dir);
    const imported = path.join(dir, "imported.pdf");
    await writeTextLayer({ pdfPath: FIXTURE, outPdfPath: imported, workDir: dir,
      pages: [{ page: 1, words: [{ text: "WRONG", bbox: [10, 10, 110, 50] }] }],
    });
    await execFileAsync(python, ["-c", `
import sys
from unittest.mock import patch
import pypdfium2 as pdfium
from pypdf import PdfWriter
sys.path.insert(0, sys.argv[1])
from pdf_image_copy import copy_without_text
w = PdfWriter(clone_from=sys.argv[2])
w.pages[0].mediabox.upper_right = (2400, 3658)
w.pages[0].cropbox.upper_right = (2400, 3658)
w.write(sys.argv[3])
render = pdfium.PdfPage.render
def bounded(page, *args, **kwargs):
    assert max(page.get_size()) * kwargs["scale"] <= 3508.01
    return render(page, *args, **kwargs)
with patch.object(pdfium.PdfPage, "render", bounded):
    result = copy_without_text(sys.argv[3])
assert tuple(result.pages[0].mediabox) == (0, 0, 2400, 3658)
image = result.pages[0]["/Resources"]["/XObject"]["/Scan"]
assert max(image["/Width"], image["/Height"]) <= 3508
`, path.resolve(import.meta.dirname, "../../../../scripts"), imported, path.join(dir, "large.pdf")]);
  });

  it.skipIf(!existsSync(python))("replaces imported OCR instead of leaving two competing text layers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "replace-text-layer-"));
    dirs.push(dir);
    const imported = path.join(dir, "imported.pdf");
    const corrected = path.join(dir, "corrected.pdf");
    await writeTextLayer({ pdfPath: FIXTURE, outPdfPath: imported, workDir: dir,
      pages: [{ page: 1, words: [{ text: "WRONG", bbox: [10, 10, 110, 50] }] }],
    });
    await writeTextLayer({ pdfPath: imported, outPdfPath: corrected, workDir: dir,
      pages: [{ page: 1, words: [{ text: "Correct", bbox: [152, 149, 305, 188] }] }],
    });
    expect((await extractPdfRawText(corrected))?.trim()).toBe("Correct");
    expect((await extractPdfRawText(imported))?.trim()).toBe("WRONG");
  });

  it.skipIf(!existsSync(python))("puts each word where its box is, invisibly, on a copy of the PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "text-layer-"));
    dirs.push(dir);
    const outPdfPath = path.join(dir, "page.ocr.pdf");
    await writeTextLayer({
      pdfPath: FIXTURE,
      outPdfPath,
      workDir: dir,
      pages: [{ page: 1, words: [{ text: "Chapter", bbox: [152, 149, 305, 188] }, { text: "Voyage", bbox: [444, 149, 583, 188] }] }],
    });
    expect(await pdfHasTextLayer(outPdfPath)).toBe(true);
    expect((await extractPdfRawText(outPdfPath))?.replace(/\s+/g, " ").trim()).toBe("Chapter Voyage");
    const { stdout } = await execFileAsync("pdftotext", ["-bbox", outPdfPath, "-"]);
    const words = [...stdout.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(\w+)<\/word>/g)].map((m) => [m[5], ...m.slice(1, 5).map((v) => Math.round(Number(v)))]);
    expect(words).toEqual([["Chapter", 152, 153, 305, 184], ["Voyage", 444, 153, 583, 184]]);
  });

  it.skipIf(!existsSync(python))("preserves the appearance and size of cropped, rotated pages in a mixed PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rotated-text-layer-"));
    dirs.push(dir);
    const imported = path.join(dir, "imported.pdf");
    const mixed = path.join(dir, "mixed.pdf");
    const corrected = path.join(dir, "corrected.pdf");
    await writeTextLayer({ pdfPath: FIXTURE, outPdfPath: imported, workDir: dir,
      pages: [{ page: 1, words: [{ text: "WRONG", bbox: [20, 20, 120, 60] }] }],
    });
    await execFileAsync(python, ["-c", `
import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter(clone_from=sys.argv[1])
p = w.pages[0]
p.cropbox.lower_left = (10, 10)
p.rotate(90)
w.add_page(PdfReader(sys.argv[2]).pages[0])
w.add_metadata({"/Title": "Preserved title"})
w.add_outline_item("Opening", 0)
w.write(sys.argv[3])
`, imported, FIXTURE, mixed]);
    await writeTextLayer({ pdfPath: mixed, outPdfPath: corrected, workDir: dir,
      pages: [{ page: 1, words: [{ text: "Correct", bbox: [30, 30, 130, 60] }] }],
    });
    expect((await extractPdfRawText(corrected))?.trim()).toBe("Correct");
    await execFileAsync(python, ["-c", `
import sys
import pypdfium2 as pdfium
from PIL import ImageChops, ImageStat
from pypdf import PdfReader
r = PdfReader(sys.argv[2])
assert r.metadata.title == "Preserved title"
assert r.outline[0].title == "Opening"
assert r.get_destination_page_number(r.outline[0]) == 0
a, b = (pdfium.PdfDocument(p) for p in sys.argv[1:])
assert len(a) == len(b) == 2
for i in range(2):
    pa, pb = a[i], b[i]
    assert pa.get_size() == pb.get_size()
    ba, bb = pa.render(scale=1), pb.render(scale=1)
    ia, ib = ba.to_pil().convert("RGB"), bb.to_pil().convert("RGB")
    difference = max(ImageStat.Stat(ImageChops.difference(ia, ib)).mean)
    assert difference < 3, difference
    ba.close()
    bb.close()
    pa.close()
    pb.close()
a.close()
b.close()
`, mixed, corrected]);
  });
});
