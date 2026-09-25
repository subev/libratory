import { test, expect, uploadFixtureBook, FAKE_CITED_REPLY, FAKE_MODEL_KEY } from "./fixtures.ts";
import { pickOption } from "./helpers/dropdown.ts";

// Indexing runs BGE-M3 embeddings locally — first load can take a while, so full tier
test.describe("chat with citations", { tag: "@slow" }, () => {
  test("UC3: a scoped chat answers with a verified citation that opens the PDF at the page", async ({ page, fakeLlm: _fakeLlm }) => {
    test.setTimeout(5 * 60_000);

    await uploadFixtureBook(page, { waitForIndex: true });
    // The assistant beside the book page searches that book
    await page.getByTestId("assistant-toggle").click();

    await pickOption(page, "assistant-model", FAKE_MODEL_KEY);
    await page.getByTestId("assistant-input").fill("Where does the voyage begin? Quote the page.");
    await page.getByTestId("assistant-send").click();

    const answer = page.getByTestId("assistant-answer").last();
    await expect(answer).toContainText(FAKE_CITED_REPLY.split(" [")[0] ?? FAKE_CITED_REPLY, { timeout: 60_000 });

    // The fixture book is not narrated, so its citation falls back to the PDF at the page
    const sources = answer.getByTestId("chat-sources");
    await expect(sources).toContainText(/tiny.book/i);
    await sources.getByTestId("chat-source-pdf").first().click();

    const preview = page.getByTestId("pdf-preview-modal");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(/page \d+/);
    await expect(preview.locator("iframe")).toHaveAttribute("src", /#page=\d+/);
  });
});
