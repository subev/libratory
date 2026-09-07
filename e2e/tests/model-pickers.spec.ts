import { test, expect, FAKE_MODEL_KEY, FAKE_NOTOOLS_KEY } from "./fixtures.ts";

test("registered models appear in pickers without a restart, grouped by source", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  await page.getByTestId("chat-model").click();
  const menu = page.getByTestId("chat-model-menu");
  await expect(menu.getByText("Custom server", { exact: true })).toBeVisible();
  await expect(menu.getByTestId(`chat-model-option-${FAKE_MODEL_KEY}`)).toHaveText(/E2E Fake/);
});

test("the chat picker shows no-tool models disabled instead of hiding them", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  await page.getByTestId("chat-model").click();
  const noTools = page.getByTestId(`chat-model-option-${FAKE_NOTOOLS_KEY}`);
  await expect(noTools).toBeDisabled();
  await expect(noTools).toHaveText(/no chat tools/);
  await expect(page.getByTestId(`chat-model-option-${FAKE_MODEL_KEY}`)).toBeEnabled();
});
