import { chromium, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "packages/server/data/tmp/bilingual-acceptance/whole-book-text.epub");
const exec = promisify(execFile);
const entries = (await exec("unzip", ["-Z1", file])).stdout.split("\n");
const manifestPath = entries.find((entry) => entry.endsWith("p2af/book.json"));
if (!manifestPath) throw new Error("No reader manifest");
const manifest = JSON.parse((await exec("unzip", ["-p", file, manifestPath], { maxBuffer: 16 * 1024 * 1024 })).stdout);
const paired = manifest.chapters.find((chapter) => chapter.bilingual?.length);
const unpaired = manifest.chapters.find((chapter) => !chapter.bilingual?.length);
const last = manifest.chapters.at(-1);
if (!paired || !unpaired || !last) throw new Error("Needs paired and unpaired chapters");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://localhost:3033/open");
  const start = performance.now();
  await page.locator("input[type=file]").setInputFiles(file);
  const chapterPicker = () => page.locator('[data-testid="reader-chapter"], select[aria-label="Chapter"]');
  await expect(chapterPicker()).toBeVisible();
  await expect(chapterPicker().locator("option")).toHaveCount(manifest.chapters.length);
  await page.context().setOffline(true);
  for (const chapter of [paired, unpaired, last, paired]) {
    await chapterPicker().selectOption(String(chapter.i));
    const refs = chapter.bilingual ?? [];
    if (refs.length) {
      await expect(page.getByTestId("bilingual-reader")).toBeVisible();
      await expect(page.locator("h1")).toHaveText(chapter.title);
      await page.locator("[data-token]").first().scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.locator("[data-token]").first().hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(page.getByTestId("bilingual-reader")).toHaveCount(0);
      const resource = path.posix.join(path.posix.dirname(manifestPath), chapter.text);
      const text = JSON.parse((await exec("unzip", ["-p", file, resource], { maxBuffer: 16 * 1024 * 1024 })).stdout).text;
      await expect(page.locator("article")).toContainText(text.split(/\n+/).find((line) => line.trim())?.slice(0, 100) ?? text.slice(0, 100));
      await expect(page.getByRole("status")).toContainText("Showing the original reader");
    }
    await expect(chapterPicker()).toHaveValue(String(chapter.i));
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  }
  await page.setViewportSize({ width: 393, height: 852 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  expect(errors).toEqual([]);
  console.log(`${manifest.chapters.length} chapters: offline paired/unpaired/last/paired transitions, correct text, word inspection and unavailable playback passed; import plus checks ${Math.round(performance.now() - start)} ms`);
} finally { await browser.close(); }
