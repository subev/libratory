import { test, expect, API_URL } from "./fixtures.ts";

// The whole chapter row opens the chapter — the title and the icon were small targets in a wide
// row — but the controls inside it keep their own clicks.
test("UC11: a click anywhere in a chapter row opens it, a click on its checkbox does not", async ({ page, request, profileId }) => {
  const res = await request.post(`${API_URL}/api/books`, {
    headers: { "x-profile-id": profileId },
    data: {
      title: "Row click",
      client: "e2e",
      chapters: [{ title: "Row click one", text: "The first story of the day, read as a radio segment." }],
    },
  });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };

  await page.goto(`/books/${id}`);
  const row = page.getByTestId("chapter-row").first();
  const modal = page.getByTestId("chapter-modal");

  const box = row.getByRole("checkbox");
  await expect(box).toBeChecked();
  await box.click();
  await expect(box).not.toBeChecked();
  await expect(modal).toBeHidden();

  // The status cell: plain text, no control under the pointer
  await row.locator("td").nth(-3).click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Row click one");
});
