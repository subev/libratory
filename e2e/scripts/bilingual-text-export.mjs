import { chromium, expect } from "@playwright/test";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "packages/server/data/tmp/bilingual-acceptance");
const browser = await chromium.launch({ headless: true });
try {
  for (const [file, hasSourceAudio] of [["lifecycle-text-only.epub", false], ["lifecycle-target-text-only.epub", true]]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:3033/open");
    await page.locator("input[type=file]").setInputFiles(path.join(directory, file));
    await expect(page.getByTestId("bilingual-reader")).toBeVisible();
    await page.context().setOffline(true);
    const words = page.locator("[data-token]");
    expect(await words.count()).toBeGreaterThan(1000);
    // The saved fixture has complete word links; inspect each language without starting playback.
    for (const side of ["source", "target"]) {
      const word = page.locator(`[data-token^="${side}:"]`).nth(2);
      await word.hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await expect(page.getByRole("tooltip")).not.toContainText("No equivalent recorded");
      expect(await page.locator("audio").evaluate((audio) => audio.paused)).toBe(true);
      await page.keyboard.press("Escape");
    }
    if (hasSourceAudio) {
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector("audio")?.paused);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector("audio")?.paused);
    } else {
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
      expect(await page.locator("audio").getAttribute("src")).toBeNull();
      await words.first().click();
      await expect(page.getByRole("status")).toContainText("No narration timing");
    }
    await page.getByRole("button", { name: "Single language", exact: true }).click();
    await expect(page.getByTestId("bilingual-reader")).toHaveCount(0);
    await expect(page.locator("article")).toContainText("LETTER I.");
    if (!hasSourceAudio) await expect(page.getByTestId("reader-play")).toBeDisabled();
    expect(errors).toEqual([]);
    console.log(`${file}: offline bilingual text, word meanings, available playback and ordinary text fallback passed`);
    await page.close();
  }
} finally { await browser.close(); }
