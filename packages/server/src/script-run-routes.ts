import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { env } from "./env.ts";
import { scriptPath } from "./lib/paths.ts";

const ymdSchema = z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/);
const paramsSchema = z.object({
  date: ymdSchema.optional(),
  from: ymdSchema.optional(),
  to: ymdSchema.optional(),
  count: z.coerce.number().int().min(1).max(30).default(10),
  perDay: z.enum(["0", "1"]).default("0"),
  synthesize: z.enum(["0", "1"]).default("0"),
  folder: z.string().regex(/^[\w. -]{1,100}$/).optional(),
  profile: z.string().uuid().optional(),
  exclude: z.string().regex(/^\d+(,\d+)*$/).max(2000).optional(),
});

function rangeError(params: z.infer<typeof paramsSchema>): string | null {
  const from = params.from ?? params.date;
  const to = params.to ?? params.from ?? params.date;
  if (!from || !to) return null;
  const span = (ymdToMs(to) - ymdToMs(from)) / 86_400_000 + 1;
  return span < 1 || span > 90 ? "Date range must run forward and span at most 90 days" : null;
}

function selectionArgs(params: z.infer<typeof paramsSchema>): string[] {
  const from = params.from ?? params.date;
  const to = params.to ?? params.from ?? params.date;
  return [
    "--count", String(params.count),
    ...(from ? ["--from", from] : []),
    ...(to ? ["--to", to] : []),
    ...(params.perDay === "1" ? ["--per-day"] : []),
  ];
}

function ymdToMs(ymd: string): number {
  const s = ymd.replaceAll("-", "");
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

const HN_SCRIPT = scriptPath("hn-top10.mjs");

// In the desktop app process.execPath is the compiled server binary, so spawning it with a script
// path re-runs the server instead of the script; BUN_BE_BUN makes that binary behave as the bun
// CLI, and node ignores it.
const scriptEnv = { ...process.env, BUN_BE_BUN: "1" };

let running = false;

// Runs scripts/hn-top10.mjs as a subprocess and streams its output as SSE so the
// web UI can trigger a feed build without a terminal. The child is deliberately
// not killed on disconnect — the book should still be created.
export function registerScriptRunRoutes(fastify: FastifyInstance) {
  fastify.get("/scripts/hn-top10/stream", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid parameters", issues: parsed.error.issues });
    }
    const params = parsed.data;
    const spanError = rangeError(params);
    if (spanError) return reply.code(400).send({ error: spanError });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: { type: "line" | "exit" | "error"; text?: string; code?: number }) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (running) {
      send({ type: "error", text: "A Hacker News build is already running — wait for it to finish" });
      res.end();
      return;
    }
    running = true;

    const args = [
      HN_SCRIPT,
      "--api", `http://localhost:${env.PORT}`,
      ...selectionArgs(params),
      ...(params.exclude ? ["--exclude", params.exclude] : []),
      ...(params.synthesize === "1" ? ["--synthesize"] : []),
      ...(params.folder ? ["--folder", params.folder] : []),
      ...(params.profile ? ["--profile", params.profile] : []),
    ];
    const child = spawn(process.execPath, args, { cwd: path.dirname(HN_SCRIPT), env: scriptEnv });

    let closed = false;
    const forward = (chunk: Buffer) => {
      if (closed) return;
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) send({ type: "line", text: line });
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("close", (code) => {
      running = false;
      if (closed) return;
      send({ type: "exit", code: code ?? -1 });
      res.end();
    });
    child.on("error", (err) => {
      running = false;
      if (closed) return;
      send({ type: "error", text: err.message });
      res.end();
    });
    request.raw.on("close", () => {
      closed = true;
    });
  });

  // Dry-run selection for the modal's preview list — runs the script in
  // --list --json mode so the picking logic stays single-sourced.
  fastify.get("/scripts/hn-top10/preview", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid parameters", issues: parsed.error.issues });
    }
    const spanError = rangeError(parsed.data);
    if (spanError) return reply.code(400).send({ error: spanError });

    const args = [
      HN_SCRIPT,
      "--list", "--json",
      ...selectionArgs(parsed.data),
    ];
    const child = spawn(process.execPath, args, { cwd: path.dirname(HN_SCRIPT), env: scriptEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill(), 120_000);
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    clearTimeout(timer);

    if (code !== 0) {
      return reply.code(502).send({ error: `Preview failed: ${err.trim().split("\n").at(-1) ?? `exit ${code}`}` });
    }
    try {
      return reply.send(JSON.parse(out));
    } catch {
      return reply.code(502).send({ error: "Preview returned unparseable output" });
    }
  });
}
