// Mirrors OCR_ENGINES in packages/server/src/schema.ts; only tesseract has a runner behind it today.
export type OcrEngine = "tesseract" | "surya";
