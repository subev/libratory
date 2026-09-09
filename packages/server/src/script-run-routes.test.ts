import Fastify from "fastify";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { DEFAULT_PROFILE_ID } from "./schema.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

import { ChildProcess, spawn } from "node:child_process";
import { registerScriptRunRoutes } from "./script-run-routes.ts";

it.each([DEFAULT_PROFILE_ID, "e5baf812-4013-4da9-8da9-e39870ade095"])(
  "forwards profile %s to the HN build script",
  async (profile) => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    // The stub only needs the streams/events this route consumes; no script or network runs.
    vi.mocked(spawn).mockImplementationOnce(() => {
      setImmediate(() => child.emit("close", 0));
      return child;
    });
    const app = Fastify();
    registerScriptRunRoutes(app);
    try {
      const reply = await app.inject({ url: "/scripts/hn-top10/stream", query: { profile } });
      expect(reply.statusCode).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/event-stream");
      expect(spawn).toHaveBeenCalledWith(
        process.execPath, expect.arrayContaining(["--profile", profile]), expect.any(Object),
      );
      expect(reply.body).toContain('"code":0');
    } finally {
      await app.close();
    }
  },
);

it("rejects malformed profile IDs before starting a script", async () => {
  const app = Fastify();
  registerScriptRunRoutes(app);
  try {
    const reply = await app.inject({ url: "/scripts/hn-top10/stream", query: { profile: "invalid" } });
    expect(reply.statusCode).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
