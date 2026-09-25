import { test, expect, uploadFixtureBook, FAKE_REPLY, FAKE_MODEL_KEY, FAKE_TINY_KEY } from "./fixtures.ts";
import { pickOption } from "./helpers/dropdown.ts";

// Ask AI is the assistant's analyze_text: the button pins the book to the panel, the question
// becomes a card because the whole text costs tokens, Run reads it, and the answer is a note
test("UC2: Ask AI reads the whole book through the assistant, saves a note, and the note becomes a chapter", async ({ page, fakeLlm: _fakeLlm }) => {
  await uploadFixtureBook(page);

  await page.getByRole("button", { name: "Ask AI (whole book)" }).click();
  const panel = page.getByTestId("assistant-panel");
  await expect(panel.getByTestId("assistant-pinned")).toContainText("Whole book");
  await pickOption(panel, "assistant-model", FAKE_MODEL_KEY);
  await panel.getByTestId("assistant-input").fill("What is this book about?");
  await panel.getByTestId("assistant-send").click();

  await panel.getByTestId("assistant-card-run").click();
  const note = panel.getByTestId("assistant-note");
  await expect(note).toContainText(FAKE_REPLY, { timeout: 30_000 });

  await page.getByTestId("stage-tab-notes").click();
  const row = page.getByTestId("note-row").first();
  await row.getByRole("button", { name: "What is this book about?" }).click();
  await expect(row.getByTestId("note-result")).toContainText(FAKE_REPLY);

  await row.getByTestId("note-to-chapter").click();
  await expect(page.getByTestId("note-chapter-added")).toBeVisible();
  await page.getByTestId("stage-tab-chapters").click();
  await expect(page.getByTestId("chapter-row")).toHaveCount(1);
});

test("UC2: a model too small for the assistant is refused by name, before anything is read", async ({ page, fakeLlm: _fakeLlm }) => {
  await uploadFixtureBook(page);

  await page.getByRole("button", { name: "Ask AI (whole book)" }).click();
  const panel = page.getByTestId("assistant-panel");
  await pickOption(panel, "assistant-model", FAKE_TINY_KEY);
  await panel.getByTestId("assistant-input").fill("Summarize");
  await panel.getByTestId("assistant-send").click();
  await expect(panel.getByTestId("assistant-request-error")).toContainText("E2E Fake Tiny");
});
