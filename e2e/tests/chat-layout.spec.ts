import { test, expect } from "@playwright/test";

// Browser-only regression: all API calls are intercepted, so no library data or model is used.
// The assistant panel is the one chat, so this is where a long answer with tables has to fit.
for (const width of [1280, 900]) {
  test(`assistant tables, pinned composer and history remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/trpc/**", async (route) => {
      const data: Record<string, unknown> = {
        "books.list": { folders: [], books: [], filterCounts: {} },
        "folders.list": [],
        "profiles.list": [{ id: "00000000-0000-4000-8000-000000000000", name: "Default", isDefault: true }],
        "llmModels.list": [{ key: "test", label: "Test model", hint: "", source: "Local", contextTokens: 8192, supportsTools: true }],
        "llmModels.getDefault": { resolved: "test" },
        "models.list": [],
        "models.capabilities": {},
        "notes.listLibrary": [],
        "chats.list": [],
        "chats.bookOptions": [],
        "chats.create": { id: "11111111-1111-4111-8111-111111111111", scope: { kind: "library" } },
      };
      const procedures = new URL(route.request().url()).pathname.split("/trpc/")[1]?.split(",") ?? [];
      const head = Object.fromEntries(procedures.map((name, index) => [index, [[{ result: { data: data[name] ?? null } }]]]));
      await route.fulfill({ contentType: "application/jsonl", body: JSON.stringify(head) + "\n" });
    });
    const table = "| Група | Допустими отсъствия |\n| --- | --- |\n| **Ясла и I група** | **30 работни дни** |\n| II, III и IV група | 15 работни дни |";
    const wideTable = "| Identifier | Value |\n| --- | --- |\n| " + "long_identifier_".repeat(25) + " | 30 |";
    const answer = `${table}\n\n${"A paragraph in a long answer.\n\n".repeat(50)}${wideTable}`;
    await page.route("**/assistant", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const chunks = [
        { type: "start", messageId: "answer" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: answer },
        { type: "text-end", id: "text" },
        { type: "finish" },
      ];
      await route.fulfill({
        contentType: "text/event-stream",
        headers: { "x-vercel-ai-ui-message-stream": "v1" },
        body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      });
    });

    await page.goto("/");
    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("assistant-model")).toContainText("Test model");
    await panel.getByTestId("assistant-input").fill("Show the attendance limits.");
    await panel.getByTestId("assistant-send").click();
    const tables = panel.getByTestId("assistant-answer").locator("table");
    await expect(tables).toHaveCount(2);
    await expect(tables.first().getByRole("columnheader")).toHaveText(["Група", "Допустими отсъствия"]);
    await expect(tables.first().locator("tbody tr")).toHaveCount(2);
    const cell = tables.first().locator("td").first();
    await expect(cell).toHaveCSS("border-top-width", "1px");
    await expect(cell).toHaveCSS("padding-left", "12px");

    // The transcript scrolls inside the panel; the page itself never does
    const scroller = panel.getByTestId("assistant-transcript");
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(panel.getByTestId("assistant-input")).toBeInViewport({ ratio: 1 });
    await expect(panel.getByTestId("assistant-model")).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overflow = panel.getByRole("region", { name: "Table", exact: true }).last();
    expect(await overflow.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    await panel.getByTestId("assistant-model").click();
    await expect(page.getByTestId("assistant-model-menu")).toBeVisible();
    await page.keyboard.press("Escape");

    // History is a dialog; New chat inside it starts an empty thread and closes it
    await panel.getByTestId("chat-history-open").click();
    const history = page.getByTestId("assistant-history-modal");
    await expect(history).toBeVisible();
    await history.getByTestId("chat-new").click();
    await expect(history).toBeHidden();
    await expect(panel.getByTestId("assistant-answer")).toHaveCount(0);

    // Collapsed to the rail, and back
    await panel.getByRole("button", { name: "Collapse the assistant" }).click();
    await expect(page.getByTestId("assistant-rail")).toBeVisible();
    await page.getByTestId("assistant-toggle").click();
    await expect(page.getByTestId("assistant-panel")).toBeVisible();
  });
}
