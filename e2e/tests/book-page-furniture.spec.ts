import { test, expect, createApiBook, uploadFixtureBook } from "./fixtures.ts";

test("the book page keeps the PDF, disk usage, and action log at hand", async ({ page, request }) => {
  await uploadFixtureBook(page);

  await page.getByTitle("Preview PDF").click();
  const preview = page.getByTestId("pdf-preview-modal");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("tiny-book.pdf");

  // The modal being visible says nothing about whether a PDF arrives in it
  const src = await preview.locator("iframe").getAttribute("src");
  expect(src).toMatch(/^\/pdf\//);
  const served = await request.get(src!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toContain("application/pdf");

  await preview.getByTitle("Close").click();
  await expect(preview).not.toBeVisible();

  await page.getByTestId("disk-usage").click();
  const disk = page.getByTestId("disk-usage-modal");
  await expect(disk).toBeVisible();
  await expect(disk).toContainText(/[KM]?B/);
  await page.keyboard.press("Escape");

  await page.getByTestId("log-dock").click();
  const log = page.getByTestId("log-modal");
  await expect(log).toBeVisible();
  await expect(log).toContainText(/Raw text: .* words/);
});

test("the chapter modal asks for a voice when re-synthesizing, not before", async ({ page, request, profileId }) => {
  await createApiBook(request, profileId, {
    title: "Voice Picking",
    voice: "say:samantha",
    chapters: [{ title: "Opening", text: "A very short opening chapter." }],
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Voice Picking" }).click();

  // Both doors to one action ask the same question — the row's icon and the modal's button
  await page.getByTestId("row-synthesize").first().click();
  const picker = page.getByTestId("voice-library-modal");
  await expect(picker).toContainText("Synthesize 1 chapter");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await page.getByTestId("chapter-open").first().click();
  const modal = page.getByTestId("chapter-modal");
  await expect(modal).toBeVisible();

  await page.getByTestId("chapter-synthesize").click();
  await expect(page.getByTestId("synthesize-modal")).toBeVisible();
  await expect(picker).toContainText("Synthesize 1 chapter");

  // Escape belongs to the picker alone — the chapter behind it must still be open
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("synthesize-modal")).toBeHidden();
  await expect(modal).toBeVisible();
});
