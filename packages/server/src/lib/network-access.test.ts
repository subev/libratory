import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env-file.ts", () => ({ updateEnvFile: vi.fn() }));

import { isLoopbackAddress, networkMayReach, registerNetworkAccessGuard, type NetworkAccess } from "./network-access.ts";

describe("isLoopbackAddress", () => {
  it("knows every spelling of this machine and nothing else", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.3.4.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.4.12")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.4.12")).toBe(false);
    expect(isLoopbackAddress("100.101.102.103")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("networkMayReach", () => {
  it("lets this machine reach everything whatever the setting", () => {
    for (const access of ["none", "shelf", "all"] as const) {
      expect(networkMayReach(access, "127.0.0.1", "/trpc/:path")).toBe(true);
      expect(networkMayReach(access, "::1", undefined)).toBe(true);
    }
  });

  it("gives the network nothing, the shelf routes, or everything", () => {
    expect(networkMayReach("none", "192.168.4.12", "/shelf")).toBe(false);
    expect(networkMayReach("shelf", "192.168.4.12", "/shelf")).toBe(true);
    expect(networkMayReach("shelf", "192.168.4.12", "/shelf/pair/:token")).toBe(true);
    expect(networkMayReach("shelf", "192.168.4.12", "/shelf/documents/:documentId")).toBe(true);
    expect(networkMayReach("shelf", "192.168.4.12", "/shelfish")).toBe(false);
    expect(networkMayReach("shelf", "192.168.4.12", "/trpc/:path")).toBe(false);
    expect(networkMayReach("shelf", "192.168.4.12", "/files/*")).toBe(false);
    expect(networkMayReach("shelf", "192.168.4.12", undefined)).toBe(false);
    expect(networkMayReach("all", "192.168.4.12", "/trpc/:path")).toBe(true);
  });
});

describe("the guard on a server", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(access: NetworkAccess) {
    const app = Fastify();
    apps.push(app);
    registerNetworkAccessGuard(app, () => access);
    app.get("/shelf", async () => ({ shelf: true }));
    app.get("/shelf/pair/:token", async () => ({ peek: true }));
    app.get("/trpc/:path", async () => ({ secret: true }));
    app.get("/files/*", async () => ({ file: true }));
    await app.ready();
    return app;
  }

  const fromNetwork = { remoteAddress: "192.168.4.12" };
  const fromHere = { remoteAddress: "127.0.0.1" };

  it("refuses the network everything by default, and this machine nothing", async () => {
    const app = await createApp("none");
    expect((await app.inject({ url: "/shelf", ...fromNetwork })).statusCode).toBe(403);
    expect((await app.inject({ url: "/trpc/x", ...fromNetwork })).statusCode).toBe(403);
    expect((await app.inject({ url: "/shelf", ...fromHere })).statusCode).toBe(200);
    expect((await app.inject({ url: "/trpc/x", ...fromHere })).statusCode).toBe(200);
  });

  it("with the shelf shared, answers only the shelf routes to the network", async () => {
    const app = await createApp("shelf");
    expect((await app.inject({ url: "/shelf", ...fromNetwork })).statusCode).toBe(200);
    expect((await app.inject({ url: "/shelf/pair/abc", ...fromNetwork })).statusCode).toBe(200);
    expect((await app.inject({ url: "/trpc/x", ...fromNetwork })).statusCode).toBe(403);
    expect((await app.inject({ url: "/files/a.m4a", ...fromNetwork })).statusCode).toBe(403);
    expect((await app.inject({ url: "/trpc/x", method: "OPTIONS", ...fromNetwork })).statusCode).toBe(403);
  });

  it("is not fooled by the URL as typed", async () => {
    const app = await createApp("shelf");
    for (const url of ["/shelf/../trpc/x", "/shelf/..%2Ftrpc/x", "/SHELF", "/shelf%2Fpair/abc", "/shelfish", "/nope"]) {
      const res = await app.inject({ url, ...fromNetwork });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
  });

  it("reads the socket, not a forwarded header", async () => {
    const app = await createApp("none");
    const res = await app.inject({ url: "/trpc/x", ...fromNetwork, headers: { "x-forwarded-for": "127.0.0.1" } });
    expect(res.statusCode).toBe(403);
  });

  it("all opens everything, for a server behind its own login", async () => {
    const app = await createApp("all");
    expect((await app.inject({ url: "/trpc/x", ...fromNetwork })).statusCode).toBe(200);
  });
});
