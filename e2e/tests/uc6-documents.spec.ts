import { test, expect, createApiBook } from "./fixtures.ts";

// Vivliostyle renders the PDF in a subprocess — real work, so full tier
test.describe("document export", { tag: "@slow" }, () => {
  test("UC6: selected chapters export as PDF and EPUB documents with working downloads", async ({ page, request, profileId }) => {
    test.setTimeout(3 * 60_000);

    await createApiBook(request, profileId, {
      title: "Paper Trail",
      chapters: [
        { title: "First pages", text: "A chapter destined for typeset paper." },
        { title: "Last pages", text: "And a closing chapter for the binding." },
      ],
    });

    await page.goto("/");
    await page.getByRole("link", { name: "Paper Trail" }).click();

    const rows = page.getByTestId("document-row");

    // Exports are serialized per book server-side — run them one after the other. One modal with one
    // CTA is what makes that safe: the old UI only disabled the format you had clicked.
    const exportAs = async (format: "pdf" | "epub") => {
      await page.getByTestId("stage-tab-chapters").click();
      await page.getByTestId("open-export").click();
      await page.getByTestId(`export-format-${format}`).click();
      await page.getByTestId("export-confirm").click();
    };

    await exportAs("pdf");
    await expect(rows.filter({ hasText: "PDF" })).toHaveCount(1, { timeout: 2 * 60_000 });
    await exportAs("epub");
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(rows.filter({ hasText: "PDF" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "EPUB" })).toHaveCount(1);

    for (const row of await rows.all()) {
      const href = await row.getByTestId("document-download").getAttribute("href");
      const download = await request.get(href!);
      expect(download.ok()).toBeTruthy();
      expect((await download.body()).length).toBeGreaterThan(1_000);
    }
  });
});
