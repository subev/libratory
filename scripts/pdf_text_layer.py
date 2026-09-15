#!/usr/bin/env python3
"""Writes an invisible text layer of already-placed words onto a copy of a PDF.

    python scripts/pdf_text_layer.py --pdf in.pdf --out out.pdf --words words.json [--tessdata DIR]

words.json is a list of {"page": N, "words": [{"text": "…", "bbox": [x0, y0, x1, y1]}, …]}, pages
1-based, boxes in PDF points of the displayed page with the origin top-left — the frame
ocr_surya.py reports its lines in. The layer is the one that script writes (a glyphless font drawn
in render mode 3, scaled to the box), one string per word rather than per line, so pdftotext,
pdf.js and page_geometry.py see each word where its ink is. The AI OCR engine uses it with words
placed by aligning the model's text to Tesseract's boxes.
"""
import argparse
import json
import os
import sys

from pypdf import PdfReader, PdfWriter

from ocr_surya import add_glyphless_font, add_text_layer, glyphless_font_bytes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--tessdata", help="directory holding pdf.ttf, used when glyphless.ttf is not beside this script")
    args = ap.parse_args()

    with open(args.words, encoding="utf-8") as f:
        pages = json.load(f)
    reader = PdfReader(args.pdf)
    writer = PdfWriter(clone_from=reader)
    font_ref = add_glyphless_font(writer, glyphless_font_bytes(args.tessdata))
    count = len(writer.pages)
    written = 0
    for entry in pages:
        index = int(entry["page"]) - 1
        if not 0 <= index < count:
            raise SystemExit(f"page {entry['page']} is outside 1-{count}")
        words = [w for w in entry["words"] if w.get("text")]
        if not words:
            continue
        add_text_layer(writer, index, words, (0.0, 0.0), font_ref)
        written += 1

    tmp = args.out + ".part"
    with open(tmp, "wb") as f:
        writer.write(f)
    os.replace(tmp, args.out)
    sys.stdout.write(json.dumps({"event": "done", "pages": written}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
