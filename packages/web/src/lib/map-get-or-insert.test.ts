import { describe, it, expect, afterEach } from "vitest";
import { installMapGetOrInsert, preparePdfWorker } from "./map-get-or-insert.ts";

const NAMES = ["getOrInsert", "getOrInsertComputed"] as const;
const saved = NAMES.flatMap((name) =>
  [Map.prototype, WeakMap.prototype].map((proto) => [proto, name, Object.getOwnPropertyDescriptor(proto, name)] as const),
);

function removeNatives() {
  for (const [proto, name] of saved) delete (proto as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  for (const [proto, name, descriptor] of saved) {
    delete (proto as unknown as Record<string, unknown>)[name];
    if (descriptor) Object.defineProperty(proto, name, descriptor);
  }
});

describe("installMapGetOrInsert", () => {
  it("computes once for a missing key and never for a present one", () => {
    removeNatives();
    installMapGetOrInsert();
    const map = new Map<string, number>([["kept", 1]]);
    let calls = 0;
    const compute = () => { calls += 1; return 2; };

    expect((map as unknown as { getOrInsertComputed(k: string, f: () => number): number }).getOrInsertComputed("fresh", compute)).toBe(2);
    expect((map as unknown as { getOrInsertComputed(k: string, f: () => number): number }).getOrInsertComputed("fresh", compute)).toBe(2);
    expect((map as unknown as { getOrInsertComputed(k: string, f: () => number): number }).getOrInsertComputed("kept", compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it("leaves a real implementation alone", () => {
    // Node has no upsert pair either, so the browser that does has to be arranged here.
    removeNatives();
    const native = function () { return "native"; };
    for (const [proto, name] of saved) Object.defineProperty(proto, name, { value: native, configurable: true, writable: true });
    installMapGetOrInsert();
    expect((Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed).toBe(native);
    expect((WeakMap.prototype as unknown as Record<string, unknown>).getOrInsert).toBe(native);
  });

  // PdfCanvas ships this function to the worker as source text. An import or a module-scope
  // reference would be a ReferenceError there, where nothing else from this file exists — and the
  // symptom would be blank pages in the one browser nobody develops in.
  it("still works when it is the only thing in scope, as it is in the worker blob", () => {
    removeNatives();
    const isolated = new Function(`return (${installMapGetOrInsert.toString()})`)() as () => void;
    isolated();
    const map = new Map<string, string>();
    expect((map as unknown as { getOrInsert(k: string, v: string): string }).getOrInsert("k", "v")).toBe("v");
    expect(map.get("k")).toBe("v");
  });
});

describe("preparePdfWorker", () => {
  const WORKER = "https://example.test/assets/pdf.worker.min.mjs";

  it("hands back the real worker where the engine has the method", () => {
    const native = function () { return "native"; };
    for (const [proto, name] of saved) Object.defineProperty(proto, name, { value: native, configurable: true, writable: true });
    expect(preparePdfWorker(WORKER)).toBe(WORKER);
  });

  // The branch no browser in CI can reach: chromium and Playwright's WebKit both have the method,
  // so nothing that renders a page will ever take it. Losing it silently costs Safari every page.
  it("wraps the worker where the engine does not, installing before it imports", async () => {
    removeNatives();
    const src = preparePdfWorker(WORKER);
    expect(src.startsWith("blob:")).toBe(true);

    const body = await (await fetch(src)).text();
    expect(body).toContain("getOrInsertComputed");
    expect(body).toContain(`await import("${WORKER}")`);
    expect(body.indexOf("await import")).toBeGreaterThan(body.indexOf("getOrInsertComputed"));
  });
});
