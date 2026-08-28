import { test, expect, createApiBook, uploadFixtureBook } from "./fixtures.ts";

test("UC1: uploaded PDF becomes a readable book with raw text", async ({ page }) => {
  await uploadFixtureBook(page);
  await expect(page.getByTestId("raw-book-block")).toContainText(/Raw text extracted — [\d,]+ words/);
  // Offered, not enabled: whether it is depends on the 5 GB Marker bundle being on this machine,
  // and useModelBundle reports ready until the status call says otherwise — so asserting enabled
  // here passes on a race where the models are absent. UC9 owns the disabled-and-explained case,
  // and the @slow tier below owns the enabled one by clicking it.
  await expect(page.getByTestId("extract-chapters")).toBeVisible();
});

// Real TTS (macOS say) + ffmpeg — full tier only
test.describe("synthesize and assemble", { tag: "@slow" }, () => {
  test("UC1: chapters synthesize with a free voice and assemble into a downloadable file", async ({ page, request, profileId }) => {
    test.setTimeout(3 * 60_000);

    await createApiBook(request, profileId, {
      title: "Audio Finale",
      voice: "say:samantha",
      chapters: [
        { title: "Opening", text: "A very short opening chapter, spoken by the built-in voice." },
        { title: "Closing", text: "And an equally short closing chapter to give the book two marks." },
      ],
    });

    await page.goto("/");
    await page.getByRole("link", { name: "Audio Finale" }).click();

    await page.getByTestId("open-synthesize").click();
    await expect(page.getByTestId("synthesize-modal")).toBeVisible();
    await page.getByTestId("synthesize-start").click();

    const playButtons = page.getByTestId("chapter-play");
    await expect(playButtons).toHaveCount(2, { timeout: 2 * 60_000 });

    await page.getByTestId("assemble-button").click();
    const assembly = page.getByTestId("assembly-row").first();
    await expect(assembly).toBeVisible({ timeout: 60_000 });

    const href = await assembly.getByTestId("assembly-download").getAttribute("href");
    const download = await request.get(href!);
    expect(download.ok()).toBeTruthy();
    expect((await download.body()).length).toBeGreaterThan(10_000);
  });
});

// marker_single (a Python model pipeline) takes minutes even for the 3-page
// fixture — full tier only (pnpm e2e:full)
test.describe("full extraction", { tag: "@slow" }, () => {
  test("UC1: extract chapters, then re-cut boundaries in the structure view", async ({ page }) => {
    test.setTimeout(15 * 60_000);

    await uploadFixtureBook(page);
    await page.getByTestId("extract-chapters").click();
    await page.getByTestId("extract-start").click();

    const rows = page.getByTestId("chapter-row");
    await expect(rows.first()).toBeVisible({ timeout: 10 * 60_000 });
    await expect(rows).toHaveCount(3, { timeout: 60_000 });

    // The chapter modal opens the source PDF over itself; both are fixed overlays, so the
    // preview has to end up on top or the click looks like it did nothing
    await rows.first().getByRole("button", { name: /Chapter 1/ }).click();
    const chapterPdf = page.getByRole("button", { name: /^p\.\d/ }).last();
    await chapterPdf.click();
    const preview = page.getByTestId("pdf-preview-modal");
    await expect(preview).toBeVisible();
    await expect(preview.locator("iframe")).toHaveAttribute("src", /^\/pdf\/.*#page=\d+/);
    await preview.getByTitle("Close").click();
    await page.keyboard.press("Escape");

    await page.getByTestId("open-structure").click();
    const modal = page.getByTestId("structure-modal");
    await expect(modal).toBeVisible();
    const headings = modal.getByRole("checkbox");
    await expect(headings.first()).toBeVisible();

    // apply asks for confirmation via a native dialog
    await modal.getByRole("checkbox", { name: /Chapter 2\. The Storm/ }).uncheck();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("apply-boundaries").click();
    await expect(modal).not.toBeVisible();
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
  });
});
