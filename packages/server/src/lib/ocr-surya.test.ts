import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURES = path.resolve(import.meta.dirname, "../../test/fixtures");
const STUB = path.join(FIXTURES, "surya-stub", "ocr_surya.py");
const BORN_DIGITAL = path.resolve(import.meta.dirname, "../../../../e2e/fixtures/tiny-book.pdf");
let python = "";

vi.mock("./model-bundles.ts", () => ({
  bundleInstalled: vi.fn(async () => true),
  readCapabilities: vi.fn(async () => ({ mlx: false, cuda: false })),
}));

import { ExtractAbortedError } from "./marker.ts";
import { makeSuryaRunner, parseSuryaEvent, runSurya, type SuryaEvent } from "./ocr-surya.ts";
import { pdfHasTextLayer } from "./pdf-raw-text.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ocr-surya-"));
  dirs.push(dir);
  return dir;
}
const exists = (p: string) => stat(p).then(() => true, () => false);

// The stub is plain Python 3, which every machine that runs the suite has on its PATH.
beforeAll(async () => {
  python = path.join(await scratch(), "python");
  await writeFile(python, '#!/bin/sh\nexec python3 "$@"\n');
  await chmod(python, 0o755);
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("parseSuryaEvent", () => {
  it("keeps the script's events and drops everything else", () => {
    expect(parseSuryaEvent('{"event":"line","page":1,"index":1,"total":2,"text":"a","bbox":[0,0,1,1]}')).toMatchObject({ event: "line", text: "a" });
    expect(parseSuryaEvent("Recognizing Text: 100%")).toBeNull();
    expect(parseSuryaEvent('{"type":"progress"}')).toBeNull();
  });
});

describe("runSurya", () => {
  it("streams the script's events in order and finishes on exit 0", async () => {
    const events: SuryaEvent["event"][] = [];
    await runSurya(["--pdf", BORN_DIGITAL, "--page", "1", "--stream-lines"], { onEvent: (e) => events.push(e.event), python, script: STUB }, "cpu");
    expect(events).toEqual(["start", "page", "detected", "line", "line", "page-done", "done"]);
  });

  it("kills the script on abort and reports it as a cancellation", async () => {
    const controller = new AbortController();
    const run = runSurya(["--pdf", BORN_DIGITAL], { onEvent: (e) => { if (e.event === "detected") controller.abort(); }, signal: controller.signal, python, script: STUB }, "cpu");
    await expect(run).rejects.toBeInstanceOf(ExtractAbortedError);
  });
});

describe("runSuryaOcr", () => {
  it("writes the searchable copy, logs a page line, and reports no confidence figure", async () => {
    const dir = await scratch();
    const outPdfPath = path.join(dir, "out.ocr.pdf");
    const logs: string[] = [];
    const stats = await makeSuryaRunner({ python, script: STUB })({
      pdfPath: BORN_DIGITAL,
      outPdfPath,
      language: null,
      workDir: path.join(dir, "work"),
      log: async (m) => { logs.push(m); },
    });
    expect(stats).toEqual({ confidence: null, lowConfidenceFraction: null });
    expect(logs).toContain("OCR page 1/1");
    expect(await pdfHasTextLayer(outPdfPath)).toBe(true);
    expect(await exists(path.join(dir, "work"))).toBe(false);
  });
});
