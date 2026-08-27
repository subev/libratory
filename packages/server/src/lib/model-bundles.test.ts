import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { scriptPath } from "./paths.ts";

// The bundle table is Python data; the gates that read it are TypeScript strings. Renaming an id
// on one side leaves the other silently ungated, which is what splitting "bulgarian" in two could
// have done to the voice picker.
const source = readFileSync(scriptPath("models.py"), "utf8");
const bundle = (id: string) => source.match(new RegExp(`\\{[^{}]*"id": "${id}"[^{}]*\\}`, "s"));

describe("scripts/models.py bundles", () => {
  it("defines every id the app gates on", () => {
    for (const id of ["extraction", "search", "bulgarian", "bulgarian-narrator"]) {
      expect(bundle(id), `models.py has no "${id}" bundle`).not.toBeNull();
    }
  });

  it("keeps the MMS Bulgarian voice downloadable off Apple Silicon", () => {
    expect(bundle("bulgarian")![0]).not.toContain("appleSiliconOnly");
  });

  it("still gates the MLX narrator on Apple Silicon", () => {
    expect(bundle("bulgarian-narrator")![0]).toContain('"appleSiliconOnly": True');
  });
});
