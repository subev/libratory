import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../../../e2e/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const viewer = new URL("../../../data/tmp/two-languages-spike/multilingual/view.html", import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(viewer.href);
  await expect(page.locator(".row")).toHaveCount(10);
  await expect(page.locator('[lang="he"]').first()).toHaveCSS("direction", "rtl");
  const turned = page.locator('[data-side="s"][data-pair="p2"][data-token="2"]');
  await turned.hover();
  await expect(page.locator('.peer[data-side="t"]')).toHaveText(["כיבתה"]);
  await page.screenshot({ path: fileURLToPath(new URL("viewer-he.png", viewer)), fullPage: true });
  await turned.click();
  await expect.poll(() => page.locator("#source").evaluate((audio) => !audio.paused && audio.currentTime > 0)).toBe(true);
  await page.selectOption("#language", "1");
  await expect(page.locator('[lang="de"]').first()).toHaveCSS("direction", "ltr");
  await page.locator('[data-side="s"][data-pair="p2"][data-token="2"]').hover();
  await expect(page.locator('.peer[data-side="t"]')).toHaveText(["schaltete", "aus"]);
  await page.screenshot({ path: fileURLToPath(new URL("viewer-de.png", viewer)), fullPage: true });
  await page.goto(new URL("view-reasoning.html", viewer).href);
  await expect(page.locator("#stats")).toContainText("Incomplete run — semantic quality unscored");
  await expect(page.locator("#stats")).toContainText("8192 output tokens (8192 reasoning)");
  await page.locator('[data-side="s"][data-pair="p2"][data-token="2"]').hover();
  await expect(page.locator(".peer")).toHaveCount(0);
  await page.selectOption("#language", "1");
  await expect(page.locator("#stats")).toContainText("Incomplete run — semantic quality unscored");
  await page.goto(new URL("view-reasoning-large.html", viewer).href);
  await expect(page.locator("#stats")).toContainText("Flash reasoning on");
  await page.locator('[data-side="s"][data-pair="p2"][data-token="2"]').hover();
  await expect(page.locator('.peer[data-side="t"]')).toHaveText(["כיבתה"]);
  await page.goto(new URL("comparison.html", viewer).href);
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect(page.locator("tbody tr").filter({ hasText: "81,920" })).toHaveCount(2);
  await page.screenshot({ path: fileURLToPath(new URL("reasoning-comparison.png", viewer)), fullPage: true });
  await page.locator('tbody tr').filter({ hasText: 'Bulgarian–German' }).filter({ hasText: '81,920' }).locator('a').click();
  await expect(page.locator('#language')).toHaveValue('1');
  await expect(page.locator('[lang="de"]').first()).toBeVisible();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Viewer passed: Hebrew RTL, direct links, German separable verb, word-seek playback, incomplete reasoning runs unscored, no page errors.");
} finally {
  await browser.close();
}
