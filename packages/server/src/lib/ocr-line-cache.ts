import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { OcrLine } from "./ocr-line-order.ts";

const lineSchema = z.object({
  id: z.number().int().positive(), text: z.string(),
  box: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
});
const pageSchema = z.object({
  page: z.number().int().positive(),
  size: z.tuple([z.number().positive(), z.number().positive()]),
  lines: z.array(lineSchema),
}).superRefine((page, ctx) => {
  if (new Set(page.lines.map((line) => line.id)).size !== page.lines.length) ctx.addIssue({ code: "custom", message: "Repeated line IDs" });
  if (page.lines.some(({ box }) => box[2] <= box[0] || box[3] <= box[1])) ctx.addIssue({ code: "custom", message: "Invalid line box" });
});
const cacheSchema = z.object({
  version: z.literal(1), sha256: z.string(), pageCount: z.number().int().positive(), pages: z.array(pageSchema),
}).superRefine((cache, ctx) => {
  if (new Set(cache.pages.map((page) => page.page)).size !== cache.pages.length || cache.pages.some((page) => page.page > cache.pageCount)) {
    ctx.addIssue({ code: "custom", message: "Invalid cached page sequence" });
  }
});
export type CachedOcrPage = z.infer<typeof pageSchema>;

export const suryaCachePath = (pdfPath: string) => `${pdfPath}.surya-lines.json`;

export async function pdfFingerprint(pdfPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pdfPath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function openLineCache(pdfPath: string, pageCount: number) {
  const sha256 = await pdfFingerprint(pdfPath);
  const target = suryaCachePath(pdfPath);
  const raw = await readFile(target, "utf8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  });
  const saved = raw === null ? null : cacheSchema.parse(JSON.parse(raw));
  const pages = new Map<number, CachedOcrPage>(saved?.sha256 === sha256 && saved.pageCount === pageCount
    ? saved.pages.map((page) => [page.page, page]) : []);
  let queue = Promise.resolve();
  return {
    pages,
    save(page: CachedOcrPage): Promise<void> {
      const checked = pageSchema.parse(page);
      if (checked.page > pageCount) throw new Error("Cached page outside PDF");
      return queue = queue.then(async () => {
        const next = new Map(pages).set(checked.page, checked);
        const value = { version: 1, sha256, pageCount, pages: [...next.values()].sort((a, b) => a.page - b.page) };
        await writeFile(`${target}.part`, JSON.stringify(value), { mode: 0o600 });
        await rename(`${target}.part`, target);
        pages.set(checked.page, checked);
      });
    },
  };
}

const recoverySchema = z.object({
  version: z.literal(1), coordinateSpace: z.literal("normalized-1000"), pdfPath: z.string(),
  source: z.object({ size: z.number(), mtimeMs: z.number() }),
  completedThrough: z.number().int().positive(), pages: z.array(pageSchema),
});

export async function importSuryaRecovery(recoveryPath: string, pdfPath: string, pageCount: number): Promise<number> {
  const recovery = recoverySchema.parse(JSON.parse(await readFile(recoveryPath, "utf8")));
  const source = await stat(pdfPath);
  if (recovery.pdfPath !== pdfPath || recovery.source.size !== source.size || recovery.source.mtimeMs !== source.mtimeMs) {
    throw new Error("Recovery belongs to a different or changed PDF");
  }
  if (recovery.pages.length !== recovery.completedThrough || recovery.completedThrough > pageCount
    || recovery.pages.some((page, i) => page.page !== i + 1)) throw new Error("Incomplete recovery page sequence");
  const cache = await openLineCache(pdfPath, pageCount);
  for (const page of recovery.pages) await cache.save(page);
  return cache.pages.size;
}

export type LinePageReady = (page: number, lines: OcrLine[]) => void;
