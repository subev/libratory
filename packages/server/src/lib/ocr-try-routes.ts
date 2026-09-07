import type { FastifyInstance } from "fastify";
import path from "node:path";

import { bundleInstalled } from "./model-bundles.ts";
import { runSurya, suryaDevice, SURYA_BUNDLE, type SuryaEvent } from "./ocr-surya.ts";
import { renderTryPage, tryFile } from "./ocr-try.ts";
import { isUuid } from "./uuid.ts";

const HEARTBEAT_MS = 15_000;

type Params = { bookId: string; fileIndex: string; page: string };

function parse(params: Params): { bookId: string; fileIndex: number; page: number } | null {
  const fileIndex = Number(params.fileIndex);
  const page = Number(params.page);
  if (!isUuid(params.bookId) || !Number.isInteger(fileIndex) || fileIndex < 0 || !Number.isInteger(page) || page < 1) return null;
  return { bookId: params.bookId, fileIndex, page };
}

export function registerOcrTryRoutes(fastify: FastifyInstance) {
  fastify.get("/ocr/try/:bookId/:fileIndex/:page.png", async (request, reply) => {
    const target = parse(request.params as Params);
    if (!target) return reply.code(400).send({ error: "Bad page reference" });
    const file = await tryFile(target.bookId, target.fileIndex).catch(() => null);
    if (!file) return reply.code(404).send({ error: "File not found" });
    const { png } = await renderTryPage(target.bookId, target.fileIndex, file.pdfPath, target.page);
    return reply.type("image/png").sendFile(path.basename(png), path.dirname(png));
  });

  // One page through Surya, its lines forwarded as they land; closing the stream kills the run.
  fastify.get("/ocr/try/:bookId/:fileIndex/:page/surya", async (request, reply) => {
    const target = parse(request.params as Params);
    if (!target) return reply.code(400).send({ error: "Bad page reference" });
    const file = await tryFile(target.bookId, target.fileIndex).catch(() => null);
    if (!file) return reply.code(404).send({ error: "File not found" });
    if (!(await bundleInstalled(SURYA_BUNDLE))) return reply.code(409).send({ error: "Surya needs the Marker/Surya models — download them from the Extract button first" });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: SuryaEvent | { event: "error"; message: string }) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => res.write(":\n\n"), HEARTBEAT_MS);
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());

    try {
      await runSurya(["--pdf", file.pdfPath, "--page", String(target.page), "--stream-lines"], { signal: controller.signal, onEvent: send }, await suryaDevice());
    } catch (err) {
      if (!controller.signal.aborted) send({ event: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });
}
