#!/usr/bin/env python3
"""Reads a scanned PDF with Surya and writes the recognised lines into a searchable copy.

    python scripts/ocr_surya.py --pdf in.pdf --out out.pdf [--page N] [--stream-lines] [--tessdata DIR]

stdout is one JSON event per line and nothing else; logs go to stderr. Every box is in PDF points in
the page's displayed frame (origin top-left, y down), the same frame a rendered PNG of the page uses.
The text layer mirrors Tesseract's: a glyphless font drawn in render mode 3, one string per line,
horizontally scaled to span the line's box, so pdftotext and pdf.js place words where the ink is.
"""
import argparse
import json
import os
import sys
import time
import zlib
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject,
)

FONT_NAME = "/GlyphLessFont"
LINE_CHUNK = 4


def emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def glyphless_font_bytes(tessdata: str | None) -> bytes:
    candidates = [Path(__file__).with_name("glyphless.ttf")]
    if tessdata:
        candidates.append(Path(tessdata) / "pdf.ttf")
    for c in candidates:
        if c.is_file():
            return c.read_bytes()
    raise SystemExit("glyphless.ttf is missing beside this script")


def flate_stream(data: bytes, **entries) -> DecodedStreamObject:
    stream = DecodedStreamObject()
    stream.set_data(data)
    for k, v in entries.items():
        stream[NameObject("/" + k)] = v
    return stream.flate_encode()


TO_UNICODE = b"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
1 beginbfrange
<0000> <ffff> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""


def add_glyphless_font(writer: PdfWriter, font_bytes: bytes):
    descriptor = DictionaryObject({
        NameObject("/Type"): NameObject("/FontDescriptor"),
        NameObject("/FontName"): NameObject(FONT_NAME),
        NameObject("/Flags"): NumberObject(4),
        NameObject("/FontBBox"): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(500), NumberObject(700)]),
        NameObject("/ItalicAngle"): NumberObject(0),
        NameObject("/Ascent"): NumberObject(700),
        NameObject("/Descent"): NumberObject(-100),
        NameObject("/CapHeight"): NumberObject(700),
        NameObject("/StemV"): NumberObject(80),
        NameObject("/FontFile2"): writer._add_object(flate_stream(font_bytes, Length1=NumberObject(len(font_bytes)))),
    })
    cid_font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/CIDFontType2"),
        NameObject("/BaseFont"): NameObject(FONT_NAME),
        NameObject("/CIDSystemInfo"): DictionaryObject({
            NameObject("/Registry"): TextStringObject("Adobe"),
            NameObject("/Ordering"): TextStringObject("Identity"),
            NameObject("/Supplement"): NumberObject(0),
        }),
        NameObject("/FontDescriptor"): writer._add_object(descriptor),
        NameObject("/DW"): NumberObject(500),
        # Every CID draws glyph 1, the font's one empty glyph
        NameObject("/CIDToGIDMap"): writer._add_object(flate_stream(b"\x00\x01" * 65536)),
    })
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type0"),
        NameObject("/BaseFont"): NameObject(FONT_NAME),
        NameObject("/Encoding"): NameObject("/Identity-H"),
        NameObject("/DescendantFonts"): ArrayObject([writer._add_object(cid_font)]),
        NameObject("/ToUnicode"): writer._add_object(flate_stream(TO_UNICODE)),
    })
    return writer._add_object(font)


def fmt(n: float) -> str:
    return f"{n:.2f}"


# View frame (top-left origin, y down, rotation applied) -> user space (bottom-left origin), plus the
# text matrix that keeps the string running along the view's horizontal on a rotated page.
def line_operators(line: dict, page, view_w: float, view_h: float) -> str:
    x0, y0, x1, y1 = line["bbox"]
    box_w = max(x1 - x0, 0.1)
    box_h = max(y1 - y0, 0.1)
    text = line["text"]
    units = text.encode("utf-16-be")
    if not units:
        return ""
    baseline_vy = y1 - box_h * 0.2
    mb = page.cropbox
    left, bottom = float(mb.left), float(mb.bottom)
    user_w, user_h = float(mb.width), float(mb.height)
    rotation = page.rotation % 360
    if rotation == 0:
        ux, uy, m = x0, user_h - baseline_vy, (1, 0, 0, 1)
    elif rotation == 90:
        ux, uy, m = baseline_vy, x0, (0, 1, -1, 0)
    elif rotation == 180:
        ux, uy, m = user_w - x0, baseline_vy, (-1, 0, 0, -1)
    else:
        ux, uy, m = user_h - baseline_vy, user_w - x0, (0, -1, 1, 0)
    ux += left
    uy += bottom
    size = box_h
    natural = 0.5 * size * (len(units) // 2)
    tz = 100.0 * box_w / natural if natural > 0 else 100.0
    return (
        f"BT 3 Tr {FONT_NAME} {fmt(size)} Tf {fmt(m[0])} {fmt(m[1])} {fmt(m[2])} {fmt(m[3])} {fmt(ux)} {fmt(uy)} Tm "
        f"{fmt(tz)} Tz <{units.hex()}> Tj ET\n"
    )


def add_text_layer(writer: PdfWriter, page_index: int, lines: list[dict], view_size: tuple[float, float], font_ref) -> None:
    page = writer.pages[page_index]
    ops = "".join(line_operators(l, page, *view_size) for l in lines)
    resources = page.get("/Resources")
    resources = resources.get_object() if resources is not None else DictionaryObject()
    page[NameObject("/Resources")] = resources
    fonts = resources.get("/Font")
    fonts = fonts.get_object() if fonts is not None else DictionaryObject()
    resources[NameObject("/Font")] = fonts
    fonts[NameObject(FONT_NAME)] = font_ref
    existing = page.get("/Contents")
    contents = list(existing.get_object()) if isinstance(existing.get_object() if existing is not None else None, ArrayObject) else ([existing] if existing is not None else [])
    wrap_open = writer._add_object(flate_stream(b"q\n"))
    wrap_close = writer._add_object(flate_stream(b"Q\n"))
    text_stream = writer._add_object(flate_stream(ops.encode("ascii")))
    page[NameObject("/Contents")] = ArrayObject([wrap_open, *contents, wrap_close, text_stream])


def page_view_sizes(pdf_path: str) -> list[tuple[float, float]]:
    doc = pdfium.PdfDocument(pdf_path)
    sizes = [(doc[i].get_width(), doc[i].get_height()) for i in range(len(doc))]
    doc.close()
    return sizes


def recognise(pdf_path: str, pages: list[int], stream_lines: bool):
    from surya.common.surya.schema import TaskNames
    from surya.detection import DetectionPredictor
    from surya.foundation import FoundationPredictor
    from surya.input.load import load_pdf
    from surya.recognition import RecognitionPredictor
    from surya.settings import settings

    log("Loading the recognition model")
    foundation = FoundationPredictor()
    det = DetectionPredictor()
    rec = RecognitionPredictor(foundation)
    sizes = page_view_sizes(pdf_path)
    total = len(pages)

    for n, page_index in enumerate(pages, 1):
        started = time.time()
        view_w, view_h = sizes[page_index]
        emit("page", page=page_index + 1, width=view_w, height=view_h)
        log(f"OCR page {n}/{total}")
        (image,), _ = load_pdf(pdf_path, [page_index], dpi=settings.IMAGE_DPI)
        (highres,), _ = load_pdf(pdf_path, [page_index], dpi=settings.IMAGE_DPI_HIGHRES)
        sx, sy = view_w / image.width, view_h / image.height

        def to_points(bbox):
            return [bbox[0] * sx, bbox[1] * sy, bbox[2] * sx, bbox[3] * sy]

        lines: list[dict] = []
        if stream_lines:
            boxes = [b.bbox for b in det([image])[0].bboxes]
            boxes.sort(key=lambda b: (round(b[1] / 10), b[0]))
            emit("detected", page=page_index + 1, lines=len(boxes))
            for start in range(0, len(boxes), LINE_CHUNK):
                chunk = boxes[start:start + LINE_CHUNK]
                result = rec([image], task_names=[TaskNames.ocr_with_boxes], bboxes=[chunk], highres_images=[highres], math_mode=False, sort_lines=False)[0]
                for tl in result.text_lines:
                    lines.append({"text": tl.text, "bbox": to_points(tl.bbox)})
                    emit("line", page=page_index + 1, index=len(lines), total=len(boxes), text=tl.text, bbox=lines[-1]["bbox"])
        else:
            result = rec([image], task_names=[TaskNames.ocr_with_boxes], det_predictor=det, highres_images=[highres], math_mode=False)[0]
            emit("detected", page=page_index + 1, lines=len(result.text_lines))
            for tl in result.text_lines:
                lines.append({"text": tl.text, "bbox": to_points(tl.bbox)})
                emit("line", page=page_index + 1, index=len(lines), total=len(result.text_lines), text=tl.text, bbox=lines[-1]["bbox"])
        emit("page-done", page=page_index + 1, elapsedMs=int((time.time() - started) * 1000))
        yield page_index, lines, (view_w, view_h)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out")
    ap.add_argument("--page", type=int, help="1-based; only this page")
    ap.add_argument("--stream-lines", action="store_true")
    ap.add_argument("--tessdata", help="directory holding pdf.ttf, used when glyphless.ttf is not beside the script")
    args = ap.parse_args()

    started = time.time()
    reader = PdfReader(args.pdf)
    page_count = len(reader.pages)
    if args.page is not None and not 1 <= args.page <= page_count:
        raise SystemExit(f"page {args.page} is outside 1-{page_count}")
    pages = [args.page - 1] if args.page else list(range(page_count))
    emit("start", pages=len(pages))

    writer = PdfWriter(clone_from=reader) if args.out else None
    font_ref = add_glyphless_font(writer, glyphless_font_bytes(args.tessdata)) if writer else None

    for page_index, lines, view_size in recognise(args.pdf, pages, args.stream_lines):
        if writer:
            add_text_layer(writer, page_index, lines, view_size, font_ref)

    if writer:
        tmp = args.out + ".part"
        with open(tmp, "wb") as f:
            writer.write(f)
        os.replace(tmp, args.out)
    emit("done", elapsedMs=int((time.time() - started) * 1000))
    return 0


if __name__ == "__main__":
    sys.exit(main())
