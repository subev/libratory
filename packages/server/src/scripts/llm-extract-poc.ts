// Measures the "llm" OCR engine (lib/ocr-llm.ts) on one PDF, page by page, against a reference
// text — the plan's proof of concept, kept as the tool for re-checking a model or a prompt change.
// Writes into --out: pages.md (the transcription, to read), reference.md (what the reference saw),
// marker/ (the layout JSON, read back through collectBlocksFromMarkerOutput to prove the contract)
// and report.json (per-page tokens, seconds, recall/precision, retries, the share of the model's
// words placed on Tesseract's boxes; totals and cost). A --reference PDF gives text only, so the
// placed share needs the Tesseract path.
//
//   pnpm --filter @libratory/server exec tsx src/scripts/llm-extract-poc.ts <pdf> --out <dir>
//     [--model flash] [--pages 1-5] [--concurrency 4] [--timeout 600]
//     [--reference <searchable.pdf>]   compare against this PDF's text layer (e.g. a Surya copy)
//     [--pack bul]                     …or against Tesseract with this pack (default eng)
//     [--price-in 0.15 --price-out 0.60] USD per million tokens
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveLlm } from "../lib/llm.ts";
import { collectBlocksFromMarkerOutput, detectBoundaryIndices } from "../lib/marker.ts";
import {
  LLM_LAYOUT_FILE,
  LLM_LAYOUT_META_FILE,
  LLM_PAGE_EDGE,
  LlmPageParseError,
  RETRY_BELOW_RECALL,
  anchorHint,
  fidelity,
  joinContinuations,
  makeLlmTranscriber,
  normalizePage,
  toMarkerJson,
  type Fidelity,
  type LlmPage,
} from "../lib/ocr-llm.ts";
import { parseTsv, pdfPageCount, type OcrWord } from "../lib/ocr-tesseract.ts";
import { ensureTessdata, tesseractEnv } from "../lib/tessdata.ts";
import { placeBlocks } from "../lib/word-alignment.ts";

const execFileAsync = promisify(execFile);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pdfArg = process.argv[2];
if (!pdfArg || pdfArg.startsWith("--")) {
  console.error("usage: llm-extract-poc.ts <pdf> --out <dir> [--model key] [--pages a-b] [--reference pdf | --pack bul]");
  process.exit(2);
}
const pdfPath: string = pdfArg;
const outDir = arg("out") ?? `${pdfPath}.llm-poc`;
const modelKey = arg("model") ?? "flash";
const concurrency = Number(arg("concurrency") ?? 4);
const timeoutMs = Number(arg("timeout") ?? 600) * 1000;
const referencePdf = arg("reference");
const pack = arg("pack") ?? "eng";
const priceIn = Number(arg("price-in") ?? 0.15);
const priceOut = Number(arg("price-out") ?? 0.6);

async function referenceText(page: number, image: string): Promise<{ text: string; source: string; words: OcrWord[] }> {
  if (referencePdf) {
    const { stdout } = await execFileAsync("pdftotext", ["-f", String(page), "-l", String(page), referencePdf, "-"], { maxBuffer: 16 * 1024 * 1024 });
    return { text: stdout, source: `pdftotext ${path.basename(referencePdf)}`, words: [] };
  }
  await ensureTessdata();
  const { stdout } = await execFileAsync("tesseract", [image, "-", "-l", pack, "tsv"], { env: tesseractEnv(), maxBuffer: 16 * 1024 * 1024 });
  const tsv = parseTsv(stdout);
  return { text: tsv.text, source: `tesseract ${pack}`, words: tsv.words };
}

async function renderPages(pages: number[], workDir: string): Promise<Map<number, string>> {
  await execFileAsync("pdftoppm", ["-scale-to", String(LLM_PAGE_EDGE), "-jpeg", "-jpegopt", "quality=85", "-gray", "-f", String(Math.min(...pages)), "-l", String(Math.max(...pages)), pdfPath, path.join(workDir, "pg")], { timeout: 600_000 });
  const out = new Map<number, string>();
  for (const f of (await readdir(workDir)).filter((f) => f.startsWith("pg-") && f.endsWith(".jpg")).sort()) {
    const n = Number(f.match(/pg-0*(\d+)\.jpg$/)?.[1]);
    if (!pages.includes(n)) continue;
    const jpeg = path.join(workDir, f);
    const webp = jpeg.replace(/\.jpg$/, ".webp");
    const encoded = await execFileAsync("cwebp", ["-quiet", "-q", "80", jpeg, "-o", webp]).then(() => true, () => false);
    out.set(n, encoded ? webp : jpeg);
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }));
  return results;
}

function pageText(page: LlmPage): string {
  return page.blocks.map((b) => b.text).join("\n\n");
}

async function main() {
  const total = await pdfPageCount(pdfPath);
  const range = arg("pages");
  const [from, to] = range ? range.split("-").map(Number) : [1, total];
  const pages = Array.from({ length: (to ?? from!) - from! + 1 }, (_, i) => from! + i);

  await rm(outDir, { recursive: true, force: true });
  const workDir = path.join(outDir, "pages");
  await mkdir(workDir, { recursive: true });
  const { model, def } = await resolveLlm(modelKey);
  const transcribe = makeLlmTranscriber(model, def);
  console.error(`${def.label} (${def.modelId}) · ${pages.length} of ${total} pages · ${LLM_PAGE_EDGE}px`);

  const t0 = Date.now();
  const images = await renderPages(pages, workDir);
  console.error(`rendered ${images.size} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const perPage = await pool(pages, concurrency, async (page) => {
    const file = images.get(page)!;
    const image = await readFile(file);
    const mediaType = file.endsWith(".webp") ? "image/webp" : "image/jpeg";
    const start = Date.now();
    const ref = await referenceText(page, file);
    let result: LlmPage | null = null;
    let fid: Fidelity | null = null;
    let error: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let attempts = 0;
    let anchored = false;
    let parseFailures = 0;
    while (attempts < 5) {
      attempts++;
      const hint = result && fid && fid.recall < RETRY_BELOW_RECALL && !anchored ? anchorHint(ref.text, result) : "";
      if (!hint && result) break;
      if (hint) anchored = true;
      try {
        const t = await transcribe({ image, mediaType, pageNumber: page, hint, signal: AbortSignal.timeout(timeoutMs) });
        inputTokens += t.inputTokens;
        outputTokens += t.outputTokens;
        const candidate = normalizePage(t.page);
        const score = fidelity(pageText(candidate), ref.text);
        if (!fid || score.recall >= fid.recall) {
          result = candidate;
          fid = score;
        }
        error = undefined;
      } catch (err) {
        error = err instanceof Error ? err.message.slice(0, 300) : String(err);
        console.error(`page ${page} attempt ${attempts} failed: ${error}`);
        if (err instanceof LlmPageParseError) {
          inputTokens += err.inputTokens;
          outputTokens += err.outputTokens;
          if (++parseFailures < 3) continue;
        }
        break;
      }
    }
    const seconds = (Date.now() - start) / 1000;
    // The image is rendered by tesseract too, so the placed share is in its pixels; points would
    // only matter for writing the layer, which the engine does and this measurement does not.
    const placed = result && ref.words.length ? placeBlocks(result.blocks.map((b) => b.text), ref.words).matchedShare : null;
    console.error(`page ${page}: ${result ? `${result.blocks.length} blocks, ${result.furniture.length} furniture, continues=${result.continues}` : "FAILED"} · ${inputTokens}+${outputTokens} tok · ${seconds.toFixed(1)}s${fid ? ` · recall ${(fid.recall * 100).toFixed(1)}% precision ${(fid.precision * 100).toFixed(1)}%` : ""}${placed !== null ? ` · placed ${(placed * 100).toFixed(1)}%` : ""}${anchored ? " · retried with anchors" : ""}`);
    return { page, result, error, inputTokens, outputTokens, seconds, attempts, anchored, fidelity: fid, placed, referenceSource: ref.source, referenceText: ref.text, imageBytes: image.length };
  });

  const wall = (Date.now() - t0) / 1000;
  const inTok = perPage.reduce((a, p) => a + p.inputTokens, 0);
  const outTok = perPage.reduce((a, p) => a + p.outputTokens, 0);
  const cost = (inTok * priceIn + outTok * priceOut) / 1_000_000;

  const joined = joinContinuations(perPage.map((p) => p.result));
  const md = perPage.map((p, i) => {
    const page = joined[i];
    const body = page
      ? page.blocks.map((b) => (b.type === "heading" ? `${"#".repeat(Math.min(6, (b.level ?? 2) + 1))} ${b.text}` : b.type === "list_item" ? `- ${b.text}` : b.text)).join("\n\n")
      : `_FAILED: ${p.error}_`;
    const furniture = page?.furniture.length ? `\n\n> furniture: ${page.furniture.map((f) => JSON.stringify(f)).join(" · ")}` : "";
    return `<!-- page ${p.page} -->\n\n${body}${furniture}`;
  }).join("\n\n---\n\n");
  await writeFile(path.join(outDir, "pages.md"), md);
  await writeFile(path.join(outDir, "reference.md"), perPage.map((p) => `<!-- page ${p.page} (${p.referenceSource}) -->\n\n${p.referenceText}`).join("\n\n---\n\n"));

  // Pages not requested still get a Page entry so numbering stays 1-based and exact.
  const allPages: (LlmPage | null)[] = Array.from({ length: total }, () => null);
  joined.forEach((p, i) => { allPages[pages[i]! - 1] = p; });
  const markerDir = path.join(outDir, "marker");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, LLM_LAYOUT_FILE), JSON.stringify(toMarkerJson(allPages), null, 1));
  await writeFile(path.join(markerDir, LLM_LAYOUT_META_FILE), JSON.stringify({ engine: "llm", model: def.modelId, scale: LLM_PAGE_EDGE }, null, 1));
  const blocks = await collectBlocksFromMarkerOutput(markerDir);
  const detection = detectBoundaryIndices(blocks);
  const headings = blocks.filter((b) => b.type === "SectionHeader");

  const report = {
    pdf: pdfPath, model: def.modelId, scale: LLM_PAGE_EDGE, pages: pages.length, totalPages: total, concurrency,
    wallSeconds: wall, inputTokens: inTok, outputTokens: outTok, costUsd: cost,
    perPageInputTokens: inTok / pages.length, perPageOutputTokens: outTok / pages.length,
    failed: perPage.filter((p) => !p.result).map((p) => p.page),
    flagged: perPage.filter((p) => p.fidelity && p.fidelity.recall < RETRY_BELOW_RECALL).map((p) => p.page),
    contract: { blocks: blocks.length, headings: headings.map((h) => `${h.page}: h${h.level ?? "?"} ${h.text.slice(0, 60)}`), detection: detection ? { method: detection.method, boundaries: detection.indices.length } : null },
    perPage: perPage.map(({ referenceText: _r, result, ...p }) => ({ ...p, blocks: result?.blocks.length, furniture: result?.furniture, continues: result?.continues })),
  };
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  const fids = perPage.map((p) => p.fidelity).filter((f): f is Fidelity => f !== null);
  const avg = (k: "recall" | "precision") => (fids.length ? fids.reduce((a, f) => a + f[k], 0) / fids.length : 0);
  const placedShares = perPage.map((p) => p.placed).filter((p): p is number => p !== null);
  const placedMean = placedShares.length ? placedShares.reduce((a, p) => a + p, 0) / placedShares.length : null;
  console.error(`\n${pages.length} pages · ${wall.toFixed(0)}s wall · ${inTok.toLocaleString()} in + ${outTok.toLocaleString()} out tokens · $${cost.toFixed(4)}`);
  console.error(`per page: ${Math.round(inTok / pages.length)} in, ${Math.round(outTok / pages.length)} out · recall ${(avg("recall") * 100).toFixed(1)}% precision ${(avg("precision") * 100).toFixed(1)}%${placedMean !== null ? ` · placed ${(placedMean * 100).toFixed(1)}%` : ""} · flagged ${report.flagged.join(", ") || "none"}`);
  console.error(`contract: ${blocks.length} blocks, ${headings.length} headings, detection ${detection ? `${detection.method} (${detection.indices.length})` : "none"}`);
  console.error(`written to ${outDir}`);
}

await main();
