import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { expect, it } from "vitest";
import { registerScriptRunRoutes } from "../script-run-routes.ts";
import { registerErrorHandler } from "./error-handler.ts";
import { SCRIPT_RATE_LIMIT } from "./request-limits.ts";

it("rejects excess script requests before execution and leaves ordinary routes available", async () => {
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(rateLimit, { global: false });
  registerScriptRunRoutes(app);
  app.get("/health", () => ({ ok: true }));
  try {
    // Invalid input lets the real handler exercise the limit without running a feed build.
    for (let i = 0; i < SCRIPT_RATE_LIMIT.max; i++) {
      expect((await app.inject("/scripts/hn-top10/preview?date=invalid")).statusCode).toBe(400);
    }
    const blocked = await app.inject("/scripts/hn-top10/preview?date=invalid");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject({ url: "/scripts/hn-top10/preview?date=invalid", remoteAddress: "127.0.0.2" })).statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
