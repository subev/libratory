import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "packages/server/data/tmp/bilingual-acceptance");
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const key of ["long", "linked"]) {
    const doc = JSON.parse(await readFile(path.join(directory, `${key}.json`), "utf8"));
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:3033/open");
    const started = performance.now();
    await page.locator("input[type=file]").setInputFiles(path.join(directory, `${key}.epub`));
    await expect(page.getByTestId("bilingual-reader")).toBeVisible();
    if (doc.source.language === "und") await expect(page.getByRole("button", { name: "Unknown language", exact: true })).toBeVisible();
    const openMs = Math.round(performance.now() - started);
    await expect(page.locator("[data-token]")).toHaveCount(doc.source.tokens.length + doc.target.tokens.length);
    await expect(page.locator("audio")).toHaveCount(1);
    await page.context().setOffline(true);
    const profiles = [];
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    for (const side of ["source", "target"]) {
      const word = doc[side].tokens.find((token) => doc[side].narration?.anchors.some((a) => a.kind === "word" && a.range[0] <= token.range[0] && a.range[1] >= token.range[1] && a.start.ms !== null && a.end.ms > a.start.ms)) ?? doc[side].tokens[0];
      if (!word) throw new Error(`No words in ${side}`);
      await page.locator(`[data-token="${side}:${word.id}"]`).click();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => {
        const audio = document.querySelector("audio");
        return audio && !audio.paused && audio.readyState >= 2;
      });
      await page.getByTestId("bilingual-paragraph").first().dispatchEvent("wheel", { deltaY: 100 });
      const before = await session.send("Performance.getMetrics");
      const frames = await page.evaluate(async () => {
        const samples = [];
        let previous = performance.now();
        const start = previous;
        await new Promise((resolve) => {
          const frame = (now) => {
            samples.push(now - previous);
            previous = now;
            if (now - start >= 5000) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        samples.sort((a, b) => a - b);
        return { durationMs: previous - start, count: samples.length, p95Ms: samples[Math.floor(samples.length * 0.95)], maxMs: samples.at(-1) };
      });
      const after = await session.send("Performance.getMetrics");
      const metric = (result, name) => result.metrics.find((m) => m.name === name)?.value ?? 0;
      profiles.push({ side, frames, taskMs: (metric(after, "TaskDuration") - metric(before, "TaskDuration")) * 1000,
        scriptMs: (metric(after, "ScriptDuration") - metric(before, "ScriptDuration")) * 1000,
        layoutMs: (metric(after, "LayoutDuration") - metric(before, "LayoutDuration")) * 1000 });
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector("audio")?.paused);
    }
    const timedWords = doc.source.narration.anchors.flatMap((anchor) => {
      if (anchor.kind !== "word" || anchor.start.ms === null || anchor.end.ms === null || anchor.end.ms <= anchor.start.ms) return [];
      const token = doc.source.tokens.find((t) => t.range[0] >= anchor.range[0] && t.range[1] <= anchor.range[1]);
      return token ? [{ id: token.id, ms: (anchor.start.ms + anchor.end.ms) / 2 }] : [];
    });
    const first = timedWords[0], last = timedWords.at(-1);
    if (first && last && first.id !== last.id) {
      await page.locator(`[data-token="source:${first.id}"]`).click();
      await page.waitForFunction(() => !document.querySelector("audio")?.paused);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector("audio")?.paused);
      await page.getByTestId("bilingual-paragraph").first().dispatchEvent("wheel", { deltaY: 100 });
      for (const word of [last, first]) {
        await page.locator("audio").evaluate((audio, ms) => { audio.currentTime = ms / 1000; }, word.ms);
        await expect(page.getByTestId("reader-word")).toHaveCount(1);
        await expect(page.getByTestId("reader-word")).toHaveAttribute("data-token", `source:${word.id}`);
      }
    }
    if (key === "linked") {
      const pair = doc.pairs.find((p) => p.links.length > 0);
      const id = pair?.links[0]?.source[0];
      if (id === undefined) throw new Error("No saved links");
      await page.mouse.move(0, 0);
      await page.locator(`[data-token="source:${id}"]`).hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      expect(await page.getByRole("tooltip").textContent()).not.toContain("No equivalent recorded");
      expect(await page.locator("audio").evaluate((audio) => audio.paused)).toBe(true);
    }
    await page.setViewportSize({ width: 393, height: 852 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: path.join(directory, `${key}-narrow.png`) });
    await page.getByRole("button", { name: "Single language", exact: true }).click();
    await expect(page.getByTestId("reader-play")).toBeVisible();
    expect(errors).toEqual([]);
    reports.push({ key, openMs, pairs: doc.pairs.length, tokens: doc.source.tokens.length + doc.target.tokens.length, profiles });
    console.log(JSON.stringify(reports.at(-1)));
    await page.close();
  }
  await writeFile(path.join(directory, "browser-report.json"), JSON.stringify(reports, null, 2));
} finally { await browser.close(); }
