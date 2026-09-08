import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const packagingRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const plist: {
  build: (value: Record<string, unknown>) => string;
  parse: (xml: string) => unknown;
} = packagingRequire("plist");

describe("macOS packaging dependencies", () => {
  it("round-trips an Info.plist with the patched XML parser", () => {
    const info = { CFBundleIdentifier: "dev.libratory.app", CFBundleVersion: "1.0.0" };
    expect(plist.parse(plist.build(info))).toEqual(info);
  });
});
