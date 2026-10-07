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

// The open chapter is the URL's ?chapter=, so a reload brings the same dialog back. It was held in
// component state with the param removed on the first click, and a refresh closed it.
test("UC10: the open chapter survives a reload, and closing it leaves the URL", async ({ page, request, profileId }) => {
  const res = await request.post(`${API_URL}/api/books`, {
    headers: { "x-profile-id": profileId },
    data: {
      title: "Reload Book",
      client: "e2e",
      chapters: [
        { title: "Reload one", text: "The first chapter, opened from the table." },
        { title: "Reload two", text: "The second chapter, reached with the bracket key." },
      ],
    },
  });
  expect(res.status()).toBe(201);
  const bookId = (await res.json()).id as string;

  await page.goto(`/books/${bookId}`);
  await page.getByTestId("chapter-row").first().getByText("Reload one").click();
  const modal = page.getByTestId("chapter-modal");
  await expect(modal).toContainText("Reload one");
  await expect(page).toHaveURL(/[?&]chapter=/);

  await page.reload();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Reload one");

  // Walking to another chapter moves the URL with it, so a reload lands on that one
  await page.keyboard.press("]");
  await expect(modal).toContainText("Reload two");
  await page.reload();
  await expect(modal).toContainText("Reload two");

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]chapter=/);
  await page.reload();
  await expect(page.getByTestId("chapter-row")).toHaveCount(2);
  await expect(modal).toBeHidden();
});
