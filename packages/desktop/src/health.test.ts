import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { probe, waitForServer } from "./health.cjs";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function serving(body: unknown, status = 200): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
}

describe("telling our server from whatever else has the port", () => {
  it("accepts the server started with this token", async () => {
    const url = await serving({ ok: true, instance: "tok-1" });
    expect(await probe(url, "tok-1")).toBe("ours");
  });

  // The case this exists for: a `pnpm dev` server passes an ok/health check and serves its own
  // web bundle, so adopting it shows a UI from whenever that checkout was last built.
  it("rejects a server answering with somebody else's token", async () => {
    const url = await serving({ ok: true, instance: "tok-other" });
    expect(await probe(url, "tok-1")).toBe("foreign");
  });

  it("rejects a server too old to carry a token at all", async () => {
    const url = await serving({ ok: true });
    expect(await probe(url, "tok-1")).toBe("foreign");
  });

  it("reports nothing listening as down, not as foreign", async () => {
    expect(await probe("http://127.0.0.1:1/health", "tok-1")).toBe("down");
  });

  it("stops at a foreign server instead of waiting out the timeout", async () => {
    const url = await serving({ ok: true, instance: "tok-other" });
    const started = Date.now();
    expect(await waitForServer(url, "tok-1", 5000)).toBe("foreign");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up on a port nothing ever answers", async () => {
    expect(await waitForServer("http://127.0.0.1:1/health", "tok-1", 100)).toBe("timeout");
  });

  it("abandons the wait once the server it spawned has died", async () => {
    expect(await waitForServer("http://127.0.0.1:1/health", "tok-1", 5000, () => true)).toBe("abandoned");
  });
});
