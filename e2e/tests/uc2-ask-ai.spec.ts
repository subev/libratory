import { test, expect, uploadFixtureBook, FAKE_REPLY, FAKE_MODEL_KEY, FAKE_TINY_KEY } from "./fixtures.ts";

test("UC2: Ask AI streams the answer, saves a note, and the note becomes a chapter", async ({ page, fakeLlm: _fakeLlm }) => {
  await uploadFixtureBook(page);

  await page.getByRole("button", { name: "Ask AI (whole book)" }).click();
  const modal = page.getByTestId("chapter-ai-modal");
  await modal.getByTestId("ai-model-toggle").selectOption(FAKE_MODEL_KEY);
  await modal.getByTestId("ai-prompt-input").fill("What is this book about?");
  await modal.getByTestId("ai-run").click();

  await expect(modal).toContainText(FAKE_REPLY);
  await expect(modal.getByTestId("ai-saved-note")).toBeVisible();
  await modal.getByTitle("Close").click();
  await expect(modal).not.toBeVisible();

  const note = page.getByTestId("note-row").first();
  await note.getByRole("button", { name: "What is this book about?" }).click();
  await expect(note.getByTestId("note-result")).toContainText(FAKE_REPLY);

  await note.getByTestId("note-to-chapter").click();
  await expect(page.getByTestId("note-chapter-added")).toBeVisible();
  await expect(page.getByTestId("chapter-row")).toHaveCount(1);
});

test("UC2: the context meter blocks a scope that exceeds the model's context", async ({ page, fakeLlm: _fakeLlm }) => {
  await uploadFixtureBook(page);

  await page.getByRole("button", { name: "Ask AI (whole book)" }).click();
  const modal = page.getByTestId("chapter-ai-modal");
  await modal.getByTestId("ai-prompt-input").fill("Summarize");
  await modal.getByTestId("ai-model-toggle").selectOption(FAKE_MODEL_KEY);
  await expect(modal.getByTestId("ai-run")).toBeEnabled();

  await modal.getByTestId("ai-model-toggle").selectOption(FAKE_TINY_KEY);
  await expect(modal.getByTestId("ai-run")).toBeDisabled();
  await expect(modal.getByTestId("ai-context-usage")).toContainText("%");
});
