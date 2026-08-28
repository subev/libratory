import { test, expect, FAKE_MODEL_KEY, FAKE_NOTOOLS_KEY } from "./fixtures.ts";

test("registered models appear in pickers without a restart, grouped by source", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  const picker = page.getByTestId("chat-model");
  await expect(picker.locator(`optgroup[label="Custom server"] option[value="${FAKE_MODEL_KEY}"]`)).toHaveText(/E2E Fake/);
});

test("the chat picker shows no-tool models disabled instead of hiding them", async ({ page, fakeLlm: _fakeLlm }) => {
  await page.goto("/chat");
  const picker = page.getByTestId("chat-model");
  const noTools = picker.locator(`option[value="${FAKE_NOTOOLS_KEY}"]`);
  await expect(noTools).toBeDisabled();
  await expect(noTools).toHaveText(/no chat tools/);
  await expect(picker.locator(`option[value="${FAKE_MODEL_KEY}"]`)).toBeEnabled();
});
