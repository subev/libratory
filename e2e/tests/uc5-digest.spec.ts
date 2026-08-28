import { test, expect, createApiBook, FAKE_REPLY, FAKE_MODEL_KEY } from "./fixtures.ts";
import { trpcQuery } from "./helpers/trpc.ts";

function sourceBook(title: string) {
  return { title, chapters: [{ title: "Only chapter", text: `The complete text of ${title}, short but digestible.` }] };
}

test("UC5: a digest writes one suspended AI chapter per source book, with a note on each source", async ({ page, request, profileId, fakeLlm: _fakeLlm }) => {
  const { id: alphaId } = await createApiBook(request, profileId, sourceBook("Source Alpha"));
  await createApiBook(request, profileId, sourceBook("Source Beta"));

  await page.goto("/");
  await page.getByRole("row", { name: /Source Alpha/ }).getByRole("checkbox").click();
  await page.getByRole("row", { name: /Source Beta/ }).getByRole("checkbox").click();
  await page.getByTestId("create-digest").click();

  const modal = page.getByTestId("digest-modal");
  await modal.getByTestId("digest-title").fill("Evening Digest");
  await modal.getByTestId("digest-prompt").fill("Retell each book as a short radio essay.");
  await modal.getByTestId("digest-model").selectOption(FAKE_MODEL_KEY);
  await modal.getByTestId("digest-create").click();

  // Creating a digest lands directly on the new book's page
  await expect(page.getByRole("heading", { name: "Evening Digest" })).toBeVisible();
  const rows = page.getByTestId("chapter-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Source Alpha" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Source Beta" })).toHaveCount(1);
  await expect(rows.first()).toContainText("suspended");
  await expect(rows.first().getByTestId("chapter-source-link")).toBeVisible();

  await page.goto("/");
  const digestRow = page.getByRole("row", { name: /Evening Digest/ });
  await expect(digestRow.getByTestId("digest-badge")).toBeVisible();

  const notes = await trpcQuery(request, "notes.list", { bookId: alphaId }, { profileId });
  expect(notes).toHaveLength(1);
  expect(notes[0].result).toContain(FAKE_REPLY);
});
