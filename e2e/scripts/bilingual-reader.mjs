import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const samples = path.join(root, "packages/server/data/tmp/bilingual-reader");
const browser = await chromium.launch({ headless: true });
try {
  for (const [key, voice, word] of [["en-bg", "Bulgarian", "Death"], ["en-he", "Hebrew", "turned"], ["bg-de", "German", "Момчето"]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3033/open");
    await page.locator("input[type=file]").setInputFiles(path.join(samples, `${key}.epub`));
    await expect(page.getByTestId("bilingual-reader")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Read with", exact: true })).toHaveValue(key);
    const inspect = page.getByRole("button", { name: `Listen from ${word}`, exact: true });
    const chosen = await inspect.count() ? inspect.first() : page.locator("[data-token]").first();
    await chosen.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    expect(await page.locator("audio").evaluate((a) => a.paused)).toBe(true);
    const anchorBox = await chosen.boundingBox(), tipBox = await page.getByRole("tooltip").boundingBox();
    const barBox = await page.getByTestId("bilingual-toolbar").boundingBox();
    if (anchorBox && tipBox && barBox) {
      if (anchorBox.y - tipBox.height - 8 >= barBox.y + barBox.height + 8) expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(anchorBox.y);
      else expect(tipBox.y).toBeGreaterThanOrEqual(anchorBox.y + anchorBox.height);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await chosen.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("audio")?.paused);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("audio")?.paused);
    const pausedAt = await page.locator("audio").evaluate((audio) => audio.currentTime);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector("audio")?.paused);
    expect(await page.locator("audio").evaluate((audio) => audio.currentTime)).toBeGreaterThanOrEqual(pausedAt);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("audio")?.paused);
    await page.getByRole("button", { name: voice, exact: true }).click();
    await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => {
      const audio = document.querySelector("audio");
      return audio && !audio.paused && audio.currentTime > 0;
    });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(await page.locator("audio").count()).toBe(1);
    await page.screenshot({ path: path.join(samples, `${key}-wide.png`) });
    await page.setViewportSize({ width: 393, height: 852 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
    if (key === "en-he") expect(await page.locator('p[lang="he"]').first().evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    await page.screenshot({ path: path.join(samples, `${key}-narrow.png`) });
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("audio")?.paused);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Single language", exact: true }).click();
    await expect(page.getByTestId("reader-play")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("with")).toBe("");
    await expect(page.getByTestId("bilingual-reader")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Read with", exact: true }).selectOption(key);
    await expect(page.getByTestId("bilingual-reader")).toBeVisible();
    if (key === "en-bg") {
      await page.getByRole("button", { name: "Single language", exact: true }).click();
      await page.getByRole("button", { name: "Open another", exact: true }).click();
      await page.locator("input[type=file]").setInputFiles(path.join(samples, "en-he.epub"));
      await expect(page.getByTestId("bilingual-reader")).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Read with", exact: true })).toHaveValue("en-he");
    }
    expect(errors).toEqual([]);
    console.log(`${key}: hover without seeking, keyboard click-to-listen, narrow layout, offline playback and return to ordinary reading passed`);
    await page.close();
  }
  const touch = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  await touch.goto("http://127.0.0.1:3033/open");
  await touch.locator("input[type=file]").setInputFiles(path.join(samples, "en-he.epub"));
  await touch.getByRole("combobox", { name: "Read with", exact: true }).selectOption("en-he");
  const word = touch.getByRole("button", { name: "Listen from turned", exact: true });
  await word.scrollIntoViewIfNeeded();
  await word.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 20, clientY: 300 });
  await expect(touch.getByRole("tooltip")).toBeVisible();
  await word.dispatchEvent("pointerup", { pointerType: "touch" });
  await word.dispatchEvent("click");
  expect(await touch.locator("audio").evaluate((audio) => audio.paused)).toBe(true);
  await touch.keyboard.press("Escape");
  await word.tap();
  await touch.waitForFunction(() => !document.querySelector("audio")?.paused);
  await touch.getByRole("button", { name: "Pause", exact: true }).tap();
  await touch.getByRole("button", { name: "Meanings on tap", exact: true }).tap();
  await word.tap();
  await expect(touch.getByRole("tooltip")).toBeVisible();
  expect(await touch.locator("audio").evaluate((audio) => audio.paused)).toBe(true);
  await touch.screenshot({ path: path.join(samples, "touch-meaning.png") });
  await touch.close();
  console.log("Touch: hold previews without playback; tap plays; explicit meanings mode previews without playback");
} finally {
  await browser.close();
}
