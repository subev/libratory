import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject


def copy_without_text(pdf_path):
    reader = PdfReader(pdf_path)
    writer = PdfWriter(clone_from=reader)
    doc = pdfium.PdfDocument(pdf_path)
    try:
        for index in range(len(reader.pages)):
            page = doc[index]
            text = page.get_textpage()
            has_text = text.count_chars() > 0
            text.close()
            if not has_text:
                page.close()
                continue

            # Rendering preserves visible lettering while discarding hidden OCR, including text
            # inside form XObjects. Lossless RGB avoids another JPEG pass over a photographed page.
            width, height = page.get_size()
            bitmap = page.render(scale=min(300 / 72, 3508 / max(width, height)))
            image = bitmap.to_pil().convert("RGB")
            stream = DecodedStreamObject()
            stream.set_data(image.tobytes())
            stream = stream.flate_encode()
            stream.update({
                NameObject("/Type"): NameObject("/XObject"),
                NameObject("/Subtype"): NameObject("/Image"),
                NameObject("/Width"): NumberObject(image.width),
                NameObject("/Height"): NumberObject(image.height),
                NameObject("/ColorSpace"): NameObject("/DeviceRGB"),
                NameObject("/BitsPerComponent"): NumberObject(8),
            })
            image.close()
            bitmap.close()
            page.close()

            replacement = writer.pages[index]
            # Keep the page object identity so bookmarks and page destinations still resolve.
            replacement[NameObject("/MediaBox")] = RectangleObject([0, 0, width, height])
            replacement[NameObject("/CropBox")] = RectangleObject([0, 0, width, height])
            replacement[NameObject("/Rotate")] = NumberObject(0)
            for name in ("/Annots", "/TrimBox", "/BleedBox", "/ArtBox"):
                replacement.pop(NameObject(name), None)
            replacement[NameObject("/Resources")] = DictionaryObject({
                NameObject("/XObject"): DictionaryObject({NameObject("/Scan"): writer._add_object(stream)}),
            })
            contents = DecodedStreamObject()
            contents.set_data(f"q {width} 0 0 {height} 0 0 cm /Scan Do Q".encode("ascii"))
            replacement[NameObject("/Contents")] = writer._add_object(contents)
    finally:
        doc.close()
    return writer
