#!/usr/bin/env python3
"""Page and line geometry for a PDF, in the same frame Marker reports block polygons in
(PDF points, origin top-left, y down), so rects from either source line up."""

import argparse
import json
import os
import re
import sys


def rounded(values):
    return [round(v, 1) for v in values]


# A wrap returns to the start of the line, so the jump has to be a large part of the line's
# width to count as one — a right-to-left script moves backwards a character at a time, and
# kerning overlaps by a fraction of one, and neither is a new row.
WRAP_FRACTION = 0.5

# pdftext reports an astral character as its two UTF-16 halves, each with a box. Escaped, they
# survive a UTF-8 write and JSON.parse pairs them back into one character of length two.
SURROGATE = re.compile("[\ud800-\udfff]")


def split_rows(chars, line_width):
    """pdftext sometimes reports two printed rows as one line, giving every word past the wrap
    the row above's y. Their characters carry their own coordinates, so the rows are recoverable."""
    threshold = max(line_width * WRAP_FRACTION, 1.0)
    rows = []
    current = []
    for char in chars:
        if current and current[-1]["bbox"][0] - char["bbox"][0] > threshold:
            rows.append(current)
            current = []
        current.append(char)
    if current:
        rows.append(current)
    return rows


def row_geometry(chars):
    """Row box, text, and one x edge per character — an exact rect for any character range."""
    text = "".join(char["char"] for char in chars)
    edges = [round(char["bbox"][0], 1) for char in chars]
    edges.append(round(chars[-1]["bbox"][2], 1))
    box = [
        min(char["bbox"][0] for char in chars),
        min(char["bbox"][1] for char in chars),
        max(char["bbox"][2] for char in chars),
        max(char["bbox"][3] for char in chars),
    ]
    return {"b": rounded(box), "t": text, "xs": edges}


def line_geometry(line):
    chars = [char for span in line["spans"] for char in (span.get("chars") or [])]
    while chars and chars[-1]["char"] in "\r\n":
        chars.pop()

    if not chars:
        text = "".join(span["text"] for span in line["spans"]).rstrip("\r\n")
        return [{"b": rounded(line["bbox"]), "t": text}] if text else []

    width = line["bbox"][2] - line["bbox"][0]
    return [row_geometry(row) for row in split_rows(chars, width) if row]


def main():
    parser = argparse.ArgumentParser(description="Extract page and line geometry from a PDF")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import pypdfium2 as pdfium
    from pdftext.extraction import dictionary_output

    doc = pdfium.PdfDocument(args.pdf)
    pages = dictionary_output(args.pdf, keep_chars=True)

    out = []
    for index, page in enumerate(pages):
        width, height = page["width"], page["height"]
        pdf_page = doc[index]
        crop = pdf_page.get_cropbox()
        media = pdf_page.get_mediabox()
        # PDF boxes are origin bottom-left; report the crop offset in the top-left frame
        offset = [round(crop[0] - media[0], 1), round(media[3] - crop[3], 1)]

        lines = []
        for block in page["blocks"]:
            for line in block["lines"]:
                lines.extend(line_geometry(line))

        out.append({
            "i": index,
            "w": round(width, 1),
            "h": round(height, 1),
            "rot": pdf_page.get_rotation(),
            "cropOffset": offset,
            "lines": lines,
        })

    doc.close()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    payload = json.dumps({"version": 3, "pages": out}, ensure_ascii=False)
    payload = SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", payload)
    partial = args.out + ".partial"
    with open(partial, "w", encoding="utf-8") as f:
        f.write(payload)
    os.replace(partial, args.out)

    print(json.dumps({"type": "done", "pages": len(out), "lines": sum(len(p["lines"]) for p in out)}), flush=True)


if __name__ == "__main__":
    main()
