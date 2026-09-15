// Mirrors OCR_ENGINES and DEFAULT_OCR_ENGINE in packages/server/src/schema.ts.
export type OcrEngine = "tesseract" | "surya" | "llm";
export const DEFAULT_OCR_ENGINE: OcrEngine = "tesseract";

// Mirrors LLM_TOKENS_PER_PAGE and LLM_PRICE_PER_MILLION_USD in packages/server/src/lib/ocr-llm.ts:
// what one page cost on the POC book, structured JSON included, at DeepSeek Flash prices.
export const LLM_OCR_USD_PER_PAGE = (1500 * 0.15 + 1700 * 0.6) / 1_000_000;

export function formatLlmOcrCost(pages: number): string {
  const usd = pages * LLM_OCR_USD_PER_PAGE;
  if (usd < 0.01) return "under a cent";
  return usd < 1 ? `about ${Math.round(usd * 100)} cents` : `about $${usd.toFixed(2)}`;
}
