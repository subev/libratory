import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerErrorHandler } from "./error-handler.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(thrown: Error) {
  const app = Fastify();
  apps.push(app);

  registerErrorHandler(app);
  app.get("/boom", async () => {
    throw thrown;
  });
  await app.ready();
  return app;
}

describe("registerErrorHandler", () => {
  it("hides the message of an unexpected error", async () => {
    const app = await createApp(new Error('Failed query: select "id", "pdf_path" from "book_files"'));

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal Server Error" });
    expect(response.body).not.toContain("pdf_path");
  });

  it("keeps the message of a client error", async () => {
    const tooLarge = Object.assign(new Error("Request file too large"), { statusCode: 413 });
    const app = await createApp(tooLarge);

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Request file too large" });
  });
});
