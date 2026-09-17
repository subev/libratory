import { expect, it } from "vitest";
import { extractionProgress } from "./extraction-progress.ts";
const logs = (...messages: string[]) => messages.map((message) => ({ message }));

it("shows saved work in both stages despite noisy logs and out-of-order AI pages", () => {
  expect(extractionProgress(logs(
    "AI transcription: 0/135 pages cached; 135 remaining with Flash",
    "Local OCR: 74/135 pages cached; 61 remaining",
    "AI read page 70/135 — 98% placed on the page (1/135 saved; 1/135 placed)",
    "Recognizing Text: 100%|many progress bars",
  ))).toBe("Local OCR 74/135 saved · AI 1/135 saved");
});
it("counts newly saved pages alongside cached ones on a resumed run", () => {
  expect(extractionProgress(logs(
    "AI transcription: 74/135 pages cached; 61 remaining with Flash",
    "AI read page 1/135 — 98% placed on the page (75/135 saved; 1/135 placed)",
  ))).toBe("AI 75/135 saved");
});
it("keeps the active source page visible beside the completed-page count", () => {
  expect(extractionProgress(logs(
    "Local OCR: 74/135 pages cached; 61 remaining",
    "OCR page 75/135 (1/61 requested)",
    "Recognizing Text: 100%|many progress bars",
  ))).toBe("Local OCR 74/135 saved (reading page 75)");
});
it("resets progress for a new file and clears it on cancellation", () => {
  const entries = logs("Local OCR: 74/135 pages cached; 61 remaining", 'Extracting file 5: "next.pdf"');
  expect(extractionProgress(entries)).toBeNull();
  entries.push(...logs("Local OCR saved page 2/10 — 2 pages cached"));
  expect(extractionProgress(entries)).toBe("Local OCR 2/10 saved");
  entries.push(...logs("Cancelled — 1 file(s) stopped, nothing extracted"));
  expect(extractionProgress(entries)).toBeNull();
});
