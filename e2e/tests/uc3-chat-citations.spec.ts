import { test, expect, uploadFixtureBook, FAKE_CITED_REPLY, FAKE_MODEL_KEY } from "./fixtures.ts";

// Indexing runs BGE-M3 embeddings locally — first load can take a while, so full tier
test.describe("chat with citations", { tag: "@slow" }, () => {
  test("UC3: a scoped chat answers with a verified citation that opens the PDF at the page", async ({ page, fakeLlm: _fakeLlm }) => {
    test.setTimeout(5 * 60_000);

    await uploadFixtureBook(page, { waitForIndex: true });
    await page.getByRole("link", { name: /Chat/ }).click();

    await page.getByTestId("chat-model").selectOption(FAKE_MODEL_KEY);
    await page.getByTestId("chat-input").fill("How does the voyage begin?");
    await page.getByTestId("chat-send").click();

    const answer = page.getByTestId("chat-assistant-message").last();
    await expect(answer).toContainText(FAKE_CITED_REPLY.split(" [")[0] ?? FAKE_CITED_REPLY, { timeout: 60_000 });

    const chip = answer.getByTestId("chat-sources").getByRole("button").first();
    await expect(chip).toContainText(/tiny.book/i);
    await chip.click();

    const preview = page.getByTestId("pdf-preview-modal");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(/page \d+/);
    await expect(preview.locator("iframe")).toHaveAttribute("src", /#page=\d+/);
  });
});
