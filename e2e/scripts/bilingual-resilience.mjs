import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const name = `.bilingual-resilience-${process.pid}.tsx`;
const harness = fileURLToPath(new URL(`../../packages/web/${name}`, import.meta.url));
const fixture = JSON.parse(await readFile(new URL("../../packages/server/src/lib/fixtures/bilingual.json", import.meta.url), "utf8"));
const audio = Buffer.alloc(44 + 8000 * 2 * 10);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
fixture.source.narration.audio = "/reader-fixture/source.wav";
fixture.target.narration.audio = "/reader-fixture/target.wav";
await writeFile(harness, `
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ReaderFor } from "./src/pages/Reader.tsx";
import { readBilingualDocument } from "../server/src/lib/bilingual-format.ts";
import "./src/styles.css";
const json = async (url) => { const response = await fetch(url); if (!response.ok) throw new Error("Attachment unavailable"); return response.json(); };
const source = { manifest: () => json("/reader-fixture/manifest"), cues: json, text: json,
  bilingual: async (url) => readBilingualDocument(await json(url)), resolve: (url) => url ?? undefined, close() {} };
createRoot(document.getElementById("root")).render(<BrowserRouter><ReaderFor source={source}/></BrowserRouter>);
`);
const browser = await chromium.launch({ headless: true });
try {
  for (const mode of ["network", "invalid", "wrong", "missing"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let firstRequests = 0;
    const chapter = (id, i) => ({ id, i, title: `Chapter ${i + 1}`, audio: fixture.source.narration.audio,
      cues: "/reader-fixture/cues", text: "/reader-fixture/text", durationMs: 10000,
      pageStart: null, pageEnd: null, mode: "text", why: "generated",
      bilingual: mode === "missing" && i === 0 ? [] : [{ key: "he", language: "he", url: `/reader-fixture/${id}` }] });
    await page.route("**/reader-fixture/*", async (route) => {
      const resource = new URL(route.request().url()).pathname.split("/").at(-1);
      if (resource?.endsWith(".wav")) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav",
          headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${audio.length}` } : {}) },
          body: audio.subarray(start, end + 1) });
        return;
      }
      let value;
      if (resource === "manifest") value = { format: "p2af/1", book: { id: "fixture", title: "Resilience", language: "en", author: null, medianBodyPt: null, cover: null }, pages: [], sources: [], chapters: [chapter("chapter", 0), chapter("second", 1)] };
      else if (resource === "text") value = { format: "p2af/1", text: fixture.source.text };
      else if (resource === "cues") value = { format: "p2af/1", totalMs: 10000, granularity: "chunk", cues: [{ t: [0, 10000], s: fixture.source.text, c: 0 }] };
      else {
        const doc = structuredClone(fixture);
        doc.chapterId = resource;
        if (resource === "chapter") {
          firstRequests++;
          if (firstRequests === 1) {
            if (mode === "network") { await route.fulfill({ status: 503, body: "unavailable" }); return; }
            if (mode === "invalid") doc.source.textRevision = "0".repeat(64);
            if (mode === "wrong") doc.chapterId = "unrelated";
          }
        }
        value = doc;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    });
    await page.route("**/bilingual-resilience-check?*", (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="root"></div><script type="module" src="/${name}"></script></body></html>` }));
    await page.goto("http://localhost:3033/bilingual-resilience-check?with=he");
    await expect(page.getByTestId("reader-play")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Showing the original reader");
    await expect(page.getByTestId("bilingual-reader")).toHaveCount(0);
    await page.getByTestId("reader-play").click();
    await page.waitForFunction(() => !document.querySelector("audio")?.paused);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("audio")?.paused);
    await expect(page.getByTestId("reader-play")).toHaveAttribute("aria-label", "Play");
    await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && a.seekable.length > 0 && a.seekable.end(0) >= 1; });
    await page.locator("audio").evaluate((audio) => { audio.currentTime = 1; audio.dispatchEvent(new Event("timeupdate")); });
    await expect(page.getByText("0:01 / 0:10", { exact: true })).toContainText("0:01");
    if (mode === "missing") {
      expect(firstRequests).toBe(0);
      await expect(page.getByRole("button", { name: "Try bilingual again" })).toHaveCount(0);
      await page.getByTestId("reader-chapter").selectOption("1");
    } else {
      expect(firstRequests).toBe(1);
      await page.getByRole("button", { name: "Try bilingual again" }).click();
    }
    await expect(page.getByTestId("bilingual-reader")).toBeVisible();
    if (mode !== "missing") {
      expect(firstRequests).toBe(2);
      expect(new URL(page.url()).searchParams.get("t")).toBe("1000");
      await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
      expect(await page.locator("audio").evaluate((audio) => audio.currentTime)).toBe(1);
    }
    await expect(page.locator('[data-token][tabindex="0"]')).toHaveCount(2);
    const sourceFirst = page.locator('[data-token="source:0"]');
    await sourceFirst.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-token="source:1"]')).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator('[data-token="source:2"]')).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-token="source:2"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(sourceFirst).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-token="target:0"]')).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-token="target:1"]')).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-token="target:0"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("audio")?.paused);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("audio")?.paused);
    await expect(page.locator('[data-token][tabindex="0"]')).toHaveCount(2);
    expect(errors).toEqual([]);
    console.log(`${mode}: ordinary reader fallback, explicit recovery, two Tab stops, LTR/RTL word navigation and keyboard playback passed`);
    await page.close();
  }
} finally { await browser.close(); await rm(harness, { force: true }); }
