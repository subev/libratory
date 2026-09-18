import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";
import { ExtractionRecoveryModal } from "./ExtractionRecoveryModal.tsx";
import type { BookFileRow } from "./BookFilesSection.tsx";

vi.mock("./Modal.tsx", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("../trpc.ts", () => ({ trpc: {
  useUtils: () => ({ books: { get: { invalidate: async () => {} } } }),
  bookFiles: {
    extractionReview: { useQuery: () => ({ data: { diagnostics: [] }, isLoading: false }) },
    resumeExtraction: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
  },
} }));

const file: BookFileRow = { id: "file", index: 0, filename: "prose.pdf", status: "failed", selected: true, skipSynthesis: true, error: null,
  extractionProgress: { saved: 142, total: 155, complete: false, reviewPages: [8], interruptedPages: [], problem: null },
};

it("shows reusable pages and a bounded call count, but blocks recovery while the server is processing", () => {
  const html = renderToStaticMarkup(<ExtractionRecoveryModal bookId="book" files={[file]} isProcessing onClose={() => {}}
    settings={{ prompt: "Book", lineOrdering: true, orderingPrompt: "Order" }} />);
  const { document } = parseHTML(html);
  expect(document.textContent ?? html).toContain("142 saved pages will be reused");
  expect(html).toContain("at most 36 new page-reading calls");
  const action = [...document.querySelectorAll("button")].find((button) => button.textContent === "Repair and resume");
  expect(action?.hasAttribute("disabled")).toBe(true);
});

it("shows the cheaper prose scope without charging for already saved pages", () => {
  const html = renderToStaticMarkup(<ExtractionRecoveryModal bookId="book" files={[file]} isProcessing={false} onClose={() => {}}
    settings={{ prompt: "Book", lineOrdering: true, orderingPrompt: "Order", fileRouting: { file: "prose" } }} />);
  expect(html).toContain("13 pages remain; at most 23 new page-reading calls");
  const { document } = parseHTML(html);
  const action = [...document.querySelectorAll("button")].find((button) => button.textContent === "Repair and resume");
  expect(action?.hasAttribute("disabled")).toBe(false);
});
