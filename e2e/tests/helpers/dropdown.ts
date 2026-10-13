import type { Locator, Page } from "@playwright/test";

// A Dropdown's trigger carries the testid and data-value; its options are `<testid>-option-<value>`.
// The open menu is portalled to the body (or the enclosing dialog), so its options are looked up
// on the page, not under the scope that holds the trigger.
export async function pickOption(scope: Page | Locator, testId: string, value: string) {
  await scope.getByTestId(testId).click();
  const page = "page" in scope ? scope.page() : scope;
  await page.getByTestId(`${testId}-option-${value}`).click();
}
