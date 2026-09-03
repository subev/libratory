import { test, expect, createApiBook } from "./fixtures.ts";

test("UC5: folders organize the library — create one, move a book in, see it inside", async ({ page, request, profileId }) => {
  await createApiBook(request, profileId, { title: "Folder Cargo", chapters: [{ title: "One", text: "Cargo text." }] });

  await page.goto("/");
  await page.getByTestId("new-folder").click();
  await page.getByTestId("new-folder-name").fill("Research");
  await page.getByTestId("new-folder-name").press("Enter");
  const folder = page.getByTestId("folder-row").filter({ hasText: "Research" });
  await expect(folder).toBeVisible();
  await expect(folder).toContainText("0");

  await page.getByRole("row", { name: /Folder Cargo/ }).getByRole("checkbox").click();
  await page.getByTestId("tray-move-to-folder").click();
  const picker = page.getByTestId("folder-picker-modal");
  await picker.getByTestId("folder-picker-row").filter({ hasText: "Research" }).click();
  await picker.getByTestId("folder-picker-move").click();
  await expect(picker).not.toBeVisible();

  await expect(page.getByRole("row", { name: /Folder Cargo/ })).not.toBeVisible();
  await expect(folder).toContainText("1");

  await folder.getByRole("link", { name: "Research" }).click();
  await expect(page.getByRole("link", { name: "Folder Cargo" })).toBeVisible();
});
