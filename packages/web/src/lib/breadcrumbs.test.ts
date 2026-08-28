import { describe, it, expect, afterEach } from "vitest";
import { breadcrumbs, installBreadcrumbs, resetBreadcrumbs } from "./breadcrumbs.ts";

const savedConsole = { error: console.error, warn: console.warn };
const hadWindow = "window" in globalThis;

type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener>();

function fakeWindow(fetchImpl: typeof fetch) {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (name: string, fn: Listener) => listeners.set(name, fn),
    fetch: fetchImpl,
  };
  return (globalThis as unknown as { window: { fetch: typeof fetch } }).window;
}

afterEach(() => {
  console.error = savedConsole.error;
  console.warn = savedConsole.warn;
  listeners.clear();
  if (!hadWindow) delete (globalThis as unknown as { window?: unknown }).window;
  resetBreadcrumbs();
});

describe("breadcrumbs", () => {
  it("records console.error and still logs it", () => {
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => void seen.push(args);
    fakeWindow(async () => new Response(null));
    installBreadcrumbs();

    console.error("boom", { id: 7 });

    expect(breadcrumbs()).toContain('boom {"id":7}');
    expect(seen).toEqual([["boom", { id: 7 }]]);
  });

  it("keeps only the most recent entries", () => {
    console.error = () => {};
    fakeWindow(async () => new Response(null));
    installBreadcrumbs();

    for (let i = 0; i < 60; i++) console.error(`line ${i}`);

    const lines = breadcrumbs().split("\n");
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toContain("line 59");
    expect(breadcrumbs()).not.toContain("line 19");
  });

  it("records a failed request without consuming its body", async () => {
    console.error = () => {};
    const body = JSON.stringify({ ok: false });
    const win = fakeWindow(async () => new Response(body, { status: 404 }));
    installBreadcrumbs();

    const response = await win.fetch("/trpc/books.updateSettings?batch=1");

    expect(breadcrumbs()).toContain("404 /trpc/books.updateSettings?batch=1");
    // The streamed tRPC link must still be able to read it
    expect(await response.text()).toBe(body);
  });

  it("leaves a successful request out of the way", async () => {
    console.error = () => {};
    const win = fakeWindow(async () => new Response("{}", { status: 200 }));
    installBreadcrumbs();

    await win.fetch("/trpc/books.list");

    expect(breadcrumbs()).toBe("");
  });

  it("records an unhandled rejection", () => {
    console.error = () => {};
    fakeWindow(async () => new Response(null));
    installBreadcrumbs();

    listeners.get("unhandledrejection")?.({ reason: new Error("nope") });

    expect(breadcrumbs()).toContain("rejected");
    expect(breadcrumbs()).toContain("nope");
  });

  it("patches the console once, however often it is installed", () => {
    const seen: unknown[][] = [];
    console.error = (...args: unknown[]) => void seen.push(args);
    fakeWindow(async () => new Response(null));
    installBreadcrumbs();
    installBreadcrumbs();

    console.error("once");

    expect(seen).toHaveLength(1);
    expect(breadcrumbs().split("\n")).toHaveLength(1);
  });
});
