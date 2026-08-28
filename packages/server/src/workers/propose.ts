import { db } from "../db.ts";
import { books, type ChapterProposal, type ChapterProposalBoundary } from "../schema.ts";
import { eq } from "drizzle-orm";
import { collectBlocksFromMarkerOutput, detectBoundaryIndices, type FlatBlock } from "../lib/marker.ts";
import { detectChaptersWithLlm } from "../lib/toc-detect.ts";
import { listMarkerSources } from "../lib/marker-sources.ts";
import { appendLog } from "../lib/log.ts";

export type ProposePayload = {
  bookId: string;
  method: "llm" | "deterministic";
};

export async function propose(payload: ProposePayload) {
  const { bookId, method } = payload;
  const log = (msg: string) => appendLog(bookId, msg);

  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new Error(`Book ${bookId} not found`);

  const createdAt = book.chapterProposal?.createdAt ?? new Date().toISOString();

  try {
    const sources = await listMarkerSources(book);
    const boundaries: ChapterProposalBoundary[] = [];
    let detection: ChapterProposal["detection"];

    if (method === "llm") {
      const files: { fileIndex: number | null; blocks: FlatBlock[]; pdfPath?: string }[] = [];
      for (const source of sources) {
        files.push({
          fileIndex: source.fileIndex,
          blocks: await collectBlocksFromMarkerOutput(source.outDir),
          pdfPath: source.pdfPath,
        });
      }
      const selected = await detectChaptersWithLlm(files, log, {
        translateTo: book.translationLanguage ?? undefined,
        model: book.chapterModel ?? undefined,
      });
      if (selected) {
        detection = "llm";
        for (const { fileIndex, blocks } of files) {
          for (const s of selected.get(fileIndex) ?? []) {
            const block = blocks[s.blockIndex];
            if (!block) continue;
            boundaries.push({
              fileIndex,
              blockIndex: s.blockIndex,
              title: s.title ?? block.text,
              ...(s.titleTranslated ? { titleTranslated: s.titleTranslated } : {}),
              page: block.page,
            });
          }
        }
      } else {
        await log("AI chapter detection returned no usable chapters");
      }
    } else {
      for (const source of sources) {
        const allBlocks = await collectBlocksFromMarkerOutput(source.outDir);
        const detected = detectBoundaryIndices(allBlocks);
        if (detected) {
          detection = detected.method;
          for (const i of detected.indices) {
            const block = allBlocks[i];
            if (!block) continue;
            boundaries.push({ fileIndex: source.fileIndex, blockIndex: i, title: block.text, page: block.page });
          }
        } else {
          await log(`No chapter headings detected for "${source.filename}"`);
        }
      }
    }

    await log(`Proposal ready: ${boundaries.length} chapter boundar${boundaries.length === 1 ? "y" : "ies"} (${method})`);
    await db
      .update(books)
      .set({ chapterProposal: { status: "done", method, detection, boundaries, createdAt }, updatedAt: new Date() })
      .where(eq(books.id, bookId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(`Chapter proposal failed: ${message}`);
    await db
      .update(books)
      .set({ chapterProposal: { status: "failed", method, error: message, createdAt }, updatedAt: new Date() })
      .where(eq(books.id, bookId));
    throw err;
  }
}
