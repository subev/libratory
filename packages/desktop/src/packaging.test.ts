import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };

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

// Finder offers the app for a .epub only if electron-builder wrote CFBundleDocumentTypes, and that
// comes from four keys in package.json that nothing else reads — a rename or a typo is invisible
// until someone right-clicks a file on a machine that has the DMG installed.
describe("what a double-clicked file opens", () => {
  const associations: Array<{ ext: string; role?: string; rank?: string }> = pkg.build.fileAssociations;

  it("claims .epub", () => {
    expect(associations.map((a) => a.ext)).toContain("epub");
  });

  // Owner or Default would make Libratory the handler for every EPUB on the machine, and it opens
  // only the synced ones it exported. Alternate puts it in Open With and leaves Books.app alone.
  it("asks for a place in Open With, not the default", () => {
    const epub = associations.find((a) => a.ext === "epub");
    expect(epub?.role).toBe("Viewer");
    expect(epub?.rank).toBe("Alternate");
  });
});
