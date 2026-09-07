// Mirrors OCR_ENGINES in packages/server/src/schema.ts. Only Tesseract is offered so far —
// Surya has no runner behind it yet, and a control whose target does not exist is not rendered.
export type OcrEngine = "tesseract" | "surya";
