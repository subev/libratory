// Mirrors OCR_ENGINES and DEFAULT_OCR_ENGINE in packages/server/src/schema.ts.
export type OcrEngine = "tesseract" | "surya";
export const DEFAULT_OCR_ENGINE: OcrEngine = "tesseract";
