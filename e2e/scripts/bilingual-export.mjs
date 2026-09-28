import { chromium, expect } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const name = `.bilingual-export-check-${process.pid}.tsx`;
const harness = fileURLToPath(new URL(`../../packages/web/${name}`, import.meta.url));
await writeFile(harness, `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExportModal } from "./src/components/book/ExportModal.tsx";
import { BilingualExportOptions } from "./src/components/book/BilingualExportOptions.tsx";
import "./src/styles.css";
const formats = [
 { id: "epub", label: "EPUB", subtitle: "Single-language text", count: 2, disabled: false },
 { id: "epub-sync", label: "synced EPUB", subtitle: "Single-language narration", count: 2, disabled: false },
 { id: "epub-bilingual", label: "Bilingual EPUB", subtitle: "Original + translation", count: 2, disabled: false }
];
function Check() {
 const [format, setFormat] = useState("epub");
 const [key, setKey] = useState("Bulgarian");
 const [audio, setAudio] = useState({ sourceAudio: true, targetAudio: true });
 const reason = key === "German" ? "Pair current sentences for every selected chapter." : undefined;
 const rows = [1, 2].map((id) => ({ id: String(id), title: "Chapter " + id, paired: key === "Bulgarian", matchedGroups: 10, linkedGroups: 8,
  source: { available: true, words: true, legacy: false }, target: { available: true, words: false, legacy: true } }));
 return <ExportModal formats={formats} value={format} onChange={setFormat} scopeSummary="2 selected chapters"
 timing={{ inFlight: 0, verb: "translating", readyCount: 2, totalCount: 2, waitForAll: false, onChange() {} }} busy={false}
 confirmReason={format === "epub-bilingual" ? reason : undefined}
 onClose={() => {}} onConfirm={() => { document.body.dataset.export = JSON.stringify({ format, key, audio }); }}
 options={format === "epub-bilingual" ? <BilingualExportOptions originalLanguage="English"
 translationLanes={[{ key: "Bulgarian", label: "Bulgarian" }, { key: "German", label: "German" }]}
 exportTranslation={key} onTranslation={setKey} bilingualAudio={audio} onAudio={setAudio} bilingualRows={rows}
 selectedCount={2} bilingualReason={reason} onPrepare={() => { document.body.dataset.prepare = key; }} /> : undefined} />;
}
createRoot(document.getElementById("root")).render(<Check/>);
`);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/bilingual-export-check", (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/${name}"></script></body></html>` }));
  await page.goto("http://localhost:3033/bilingual-export-check");
  await expect(page.getByTestId("export-confirm")).toHaveText("Export EPUB");
  await expect(page.getByTestId("bilingual-export-options")).toHaveCount(0);
  await page.getByTestId("export-format-epub-bilingual").click();
  await expect(page.getByTestId("bilingual-export-options")).toBeVisible();
  await expect(page.getByText(/Older MP3 recordings/)).toBeVisible();
  await page.getByLabel("Translation", { exact: true }).selectOption("German");
  await expect(page.getByTestId("export-confirm")).toBeDisabled();
  await page.getByTestId("bilingual-export-pair").click();
  expect(await page.locator("body").getAttribute("data-prepare")).toBe("German");
  await page.getByLabel("Translation", { exact: true }).selectOption("Bulgarian");
  await expect(page.getByTestId("bilingual-export-pair")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Original/ }).uncheck();
  await page.getByRole("checkbox", { name: /Bulgarian/ }).uncheck();
  await expect(page.getByText(/Older MP3 recordings/)).toHaveCount(0);
  await page.getByTestId("export-confirm").click();
  expect(JSON.parse(await page.locator("body").getAttribute("data-export"))).toEqual({ format: "epub-bilingual", key: "Bulgarian", audio: { sourceAudio: false, targetAudio: false } });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByRole("checkbox", { name: /Bulgarian/ }).check();
  await expect(page.getByTestId("export-confirm")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await page.screenshot({ path: "/tmp/bilingual-export-picker.png" });
  await page.getByTestId("export-format-epub-sync").click();
  await expect(page.getByTestId("bilingual-export-options")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log("Export picker: explicit format, language choice, recording choices, missing-pair refusal, MP3 notice and narrow layout passed.");
} finally {
  await browser.close();
  await rm(harness, { force: true });
}
