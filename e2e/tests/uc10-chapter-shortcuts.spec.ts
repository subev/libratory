import { test, expect, API_URL } from "./fixtures.ts";

// [ and ] switch books from the shelf, but inside the chapter modal they must walk the chapters and
// never leak to the book switch — spamming the key used to change the book under the open modal.
test("UC10: [ and ] walk chapters inside the modal and never switch the book", async ({ page, request, profileId }) => {
  const make = async (title: string) => {
    const res = await request.post(`${API_URL}/api/books`, {
      headers: { "x-profile-id": profileId },
      data: {
        title,
        client: "e2e",
        chapters: [
          { title: `${title} one`, text: "The first story of the day, read as a radio segment." },
          { title: `${title} two`, text: "The second story follows after a short pause." },
          { title: `${title} three`, text: "The third story closes the programme." },
        ],
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  };
  await make("Shortcut A");
  const b = await make("Shortcut B");

  await page.goto(`/books/${b}`);
  await expect(page.getByTestId("chapter-row")).toHaveCount(3);
  await page.getByTestId("chapter-row").first().getByText("Shortcut B one").click();
  const modal = page.getByTestId("chapter-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Shortcut B one");
  for (let i = 0; i < 6; i++) await page.keyboard.press("]");
  await expect(modal).toContainText("Shortcut B three");
  await expect(page).toHaveURL(new RegExp(b));
  await page.keyboard.press("[");
  await expect(modal).toContainText("Shortcut B two");
  await expect(page).toHaveURL(new RegExp(b));
});
