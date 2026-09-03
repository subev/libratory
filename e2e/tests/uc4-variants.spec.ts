import { test, expect, createApiBook, FAKE_REPLY, FAKE_MODEL_KEY } from "./fixtures.ts";
import { trpcQuery } from "./helpers/trpc.ts";

const CHAPTER_TEXT = "The original chapter text that must survive the transform untouched.";

test("UC4: a rewrite variant streams in and keeps its params; the original stays untouched", async ({ page, request, profileId, fakeLlm: _fakeLlm }) => {
  const created = await createApiBook(request, profileId, {
    title: "Variant Factory",
    chapters: [{ title: "The only chapter", text: CHAPTER_TEXT }],
  });
  const chapterId = created.chapters[0].id;

  await page.goto("/");
  await page.getByRole("link", { name: "Variant Factory" }).click();
  // Creating a variant is now the last item of the version picker that switches between them
  await page.getByTestId("variant-menu-trigger").click();
  await page.getByTestId("open-translation").click();

  const modal = page.getByTestId("translation-modal");
  await modal.getByTestId("translation-language").selectOption("preset:eli5");
  await modal.getByTestId("translation-thinking-toggle").check();
  await modal.getByTestId("variant-model").selectOption(FAKE_MODEL_KEY);
  await modal.getByTestId("translation-start").click();

  await expect(modal.getByTestId("translation-text")).toContainText(FAKE_REPLY);
  await expect(modal.getByTestId("translation-progress")).not.toBeVisible();

  const variant = await trpcQuery(request, "variants.get", { chapterId, key: "eli5" }, { profileId });
  expect(variant.status).toBe("done");
  expect(variant.params?.model).toBe(FAKE_MODEL_KEY);
  expect(variant.params?.thinking).toBe(true);
  expect(variant.text).toContain(FAKE_REPLY);

  const chapter = await trpcQuery(request, "chapters.get", { id: chapterId }, { profileId });
  expect(chapter.rawText).toBe(CHAPTER_TEXT);
});
