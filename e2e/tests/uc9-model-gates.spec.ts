import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";

import { test, expect, uploadFixtureBook } from "./fixtures.ts";

// Setup stopped downloading ~11 GB of optional models, so each one now arrives at the doorway of
// the feature that needs it. Seeing that state otherwise means deleting gigabytes; this file makes
// it reachable, and lives here rather than in an env var because the suite drives an
// already-running dev server whose environment it cannot set.
const MARKER = path.resolve(import.meta.dirname, "../../.models-missing");

test.beforeEach(() => writeFileSync(MARKER, "extraction\nsearch\n"));
test.afterEach(() => rmSync(MARKER, { force: true }));

test("UC9: full extraction is offered with its download, not silently broken", async ({ page }) => {
  await uploadFixtureBook(page);

  // `model-<id>-notice` is DownloadNotice's id (ModelBundleNotice passes testIdPrefix={`model-${id}`}).
  // `model-notice-<id>` is a different element — the fallback shown when the bundle cannot be offered.
  const notice = page.getByTestId("model-extraction-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("Marker layout and OCR");
  await expect(notice).toContainText("5.0 GB");

  // Visible and explaining itself, rather than hidden — the rule the rest of the app follows
  const extract = page.getByTestId("extract-chapters");
  await expect(extract).toBeVisible();
  await expect(extract).toBeDisabled();
  await expect(extract).toHaveAttribute("title", /needs the Marker models/);
});

test("UC9: library chat says what it needs before it answers badly", async ({ page }) => {
  await page.goto("/chat");

  const notice = page.getByTestId("model-search-notice");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText("BGE-M3");
  await expect(notice).toContainText("4.2 GB");
});
