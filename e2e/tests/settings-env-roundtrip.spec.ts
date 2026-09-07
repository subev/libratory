import fs from "node:fs/promises";
import { test, expect } from "./fixtures.ts";
import { trpcQuery, trpcMutation } from "./helpers/trpc.ts";
import { ENV_PATH } from "./helpers/env.ts";

const DUMMY_KEY = "sk-e2e-dummy-1234";

// Mirrors slugOf in SettingsModal
const slug = (envVar: string) => envVar.replace(/_API_KEY$/, "").toLowerCase().replaceAll("_", "-");

test("settings: a saved cloud key lands in .env and the pickers, and removal restores .env byte-identical", async ({ page, request }) => {
  const snapshot = await fs.readFile(ENV_PATH, "utf8");
  const secrets = await trpcQuery(request, "secrets.list");
  const target = (secrets.keys as { kind: string; label: string; envVar: string; configured: boolean }[]).find(
    (k) => k.kind === "llm" && !k.configured,
  );
  if (!target) {
    test.skip(true, "every cloud provider already has a key in .env");
    return;
  }

  try {
    await page.goto("/");
    await page.getByTestId("settings-gear").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();

    // Local-server auto-discovery renders a card per server, running or not
    await expect(page.getByTestId("settings-local-ollama")).toBeVisible();
    await expect(page.getByTestId("settings-local-lm-studio")).toBeVisible();

    const card = page.getByTestId(`settings-key-${slug(target.envVar)}`);
    await expect(card).toContainText("no key");
    await card.getByTestId(`settings-key-input-${slug(target.envVar)}`).fill(DUMMY_KEY);
    await card.getByTestId(`settings-key-save-${slug(target.envVar)}`).click();
    await expect(card).toContainText(/key set/);

    expect(await fs.readFile(ENV_PATH, "utf8")).toContain(`${target.envVar}=${DUMMY_KEY}`);

    // The provider's models appear in pickers without a server restart
    await page.goto("/chat");
    await page.getByTestId("chat-model").click();
    await expect(page.getByTestId("chat-model-menu").getByText(target.label, { exact: true })).toHaveCount(1);

    await page.goto("/");
    await page.getByTestId("settings-gear").click();
    await card.getByTestId(`settings-key-remove-${slug(target.envVar)}`).click();
    await expect(card).toContainText("no key");

    expect(await fs.readFile(ENV_PATH, "utf8")).toBe(snapshot);

    await page.goto("/chat");
    await page.getByTestId("chat-model").click();
    await expect(page.getByTestId("chat-model-menu")).toBeVisible();
    await expect(page.getByTestId("chat-model-menu").getByText(target.label, { exact: true })).toHaveCount(0);
  } finally {
    // Failure-path safety net: clear the key from the server's memory and restore the file
    await trpcMutation(request, "secrets.set", { envVar: target.envVar, value: null }).catch(() => {});
    if ((await fs.readFile(ENV_PATH, "utf8")) !== snapshot) await fs.writeFile(ENV_PATH, snapshot);
  }
});
