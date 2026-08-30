import { test, expect } from "./fixtures.ts";

test("appearance can be pinned and survives a reload", async ({ page }) => {
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).not.toHaveAttribute("data-theme");

  await page.getByTestId("theme-toggle").click();
  const menu = page.getByTestId("theme-menu");
  await expect(menu.getByRole("radio", { name: /Auto/ })).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("theme-dark").click();
  await expect(menu).toBeHidden();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-toggle").click();
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("theme-auto").click();
  await expect(root).not.toHaveAttribute("data-theme");

  await page.getByTestId("theme-toggle").click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.getByTestId("theme-toggle").click();
  await expect(menu).toBeVisible();
  await page.locator("h1").click();
  await expect(menu).toBeHidden();
});
