import { test, expect } from "./fixtures.ts";

// The shell half cannot be driven from a browser, so this stands in for it: the payload
// electron-updater emits, over the bridge preload.cjs exposes. It is what catches the two drifting.
type Progress = { percent: number; transferred: number; total: number } | null;

async function withFakeShell(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const listeners: ((progress: unknown) => void)[] = [];
    (window as unknown as { setup: unknown }).setup = {
      onUpdateProgress: (fn: (progress: unknown) => void) => listeners.push(fn),
    };
    (window as unknown as { emitProgress: (p: unknown) => void }).emitProgress = (progress) => {
      for (const fn of listeners) fn(progress);
    };
  });
}

const emit = (page: import("@playwright/test").Page, progress: Progress) =>
  page.evaluate((next) => (window as unknown as { emitProgress: (p: Progress) => void }).emitProgress(next), progress);

test("an update download is visible in the window, not only on the Dock", async ({ page }) => {
  await withFakeShell(page);
  await page.goto("/");

  const bar = page.getByTestId("update-progress");
  await expect(bar).toBeHidden();

  await emit(page, { percent: 50, transferred: 95e6, total: 190e6 });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("50% — 95 MB of 190 MB");

  await emit(page, { percent: 100, transferred: 190e6, total: 190e6 });
  await expect(bar).toContainText("100% — 190 MB of 190 MB");

  // null is how every ending arrives — downloaded, cancelled or failed. Without it the bar would
  // sit at its last reading for the rest of the session.
  await emit(page, null);
  await expect(bar).toBeHidden();
});

test("the bar survives navigation, because a download outlives the page it started on", async ({ page }) => {
  await withFakeShell(page);
  await page.goto("/");
  await emit(page, { percent: 20, transferred: 38e6, total: 190e6 });
  await expect(page.getByTestId("update-progress")).toBeVisible();

  await page.getByTestId("library-chat-link").click();
  await expect(page.getByTestId("update-progress")).toContainText("20% — 38 MB of 190 MB");
});
