import { test, expect, FAKE_MODEL_KEY, FAKE_NOTOOLS_KEY, uploadFixtureBook } from "./fixtures.ts";
import { trpcMutation } from "./helpers/trpc.ts";

test("registered models appear in pickers without a restart, grouped by source", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  await page.getByTestId("chat-model").click();
  const menu = page.getByTestId("chat-model-menu");
  await expect(menu.getByText("Custom server", { exact: true })).toBeVisible();
  await expect(menu.getByTestId(`chat-model-option-${FAKE_MODEL_KEY}`)).toHaveText(/E2E Fake/);
});

test("the chat picker shows no-tool models disabled instead of hiding them", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  await page.getByTestId("chat-model").click();
  const noTools = page.getByTestId(`chat-model-option-${FAKE_NOTOOLS_KEY}`);
  await expect(noTools).toBeDisabled();
  await expect(noTools).toHaveText(/no chat tools/);
  await expect(page.getByTestId(`chat-model-option-${FAKE_MODEL_KEY}`)).toBeEnabled();
});

test("a book's stored model still reads as set when no listing carries it", async ({ page, request, fakeLlm: _fakeLlm }) => {
  const STORED = "deepseek:deepseek-not-in-any-listing";
  await uploadFixtureBook(page);
  const bookId = page.url().split("/books/")[1] ?? "";

  // TOC-guided detection is what puts this picker on screen, and the key is one nothing lists: a
  // retired id, or a provider whose key was since removed. Extraction still runs on it, so a trigger
  // reading "Choose a model" describes a state the book is not in.
  await trpcMutation(request, "books.updateSettings", {
    id: bookId,
    llmChapterDetection: true,
    chapterModel: STORED,
  });

  await page.reload();
  await page.getByTestId("extract-chapters").click();
  const trigger = page.getByTestId("extract-chapter-model");
  await expect(trigger).toHaveAttribute("data-value", STORED);
  await expect(trigger).toContainText("(not available right now)");
});
