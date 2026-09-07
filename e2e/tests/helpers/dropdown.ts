import type { Locator, Page } from "@playwright/test";

// A Dropdown's trigger carries the testid and data-value; its options are `<testid>-option-<value>`.
export async function pickOption(scope: Page | Locator, testId: string, value: string) {
  await scope.getByTestId(testId).click();
  await scope.getByTestId(`${testId}-option-${value}`).click();
}
