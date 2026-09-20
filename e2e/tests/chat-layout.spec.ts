import { test, expect } from "@playwright/test";

// Browser-only regression: all API calls are intercepted, so no library data or model is used.
for (const width of [1280, 390]) {
  test(`chat tables, pinned controls and history remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/trpc/**", async (route) => {
      const data: Record<string, unknown> = {
        "folders.list": [],
        "search.indexStatus": { total: 0, done: 0, running: 0 },
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
    await page.route("**/chat", async (route) => {
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

    await page.goto("/chat");
    await expect(page.getByTestId("chat-model")).toContainText("Test model");
    await page.getByTestId("chat-input").fill("Show the attendance limits.");
    await page.getByTestId("chat-send").click();
    const tables = page.getByTestId("chat-assistant-message").locator("table");
    await expect(tables).toHaveCount(2);
    await expect(tables.first().getByRole("columnheader")).toHaveText(["Група", "Допустими отсъствия"]);
    await expect(tables.first().locator("tbody tr")).toHaveCount(2);
    const cell = tables.first().locator("td").first();
    await expect(cell).toHaveCSS("border-top-width", "1px");
    await expect(cell).toHaveCSS("padding-left", "12px");

    // The first question gives the chat its own address without dropping the answer it is streaming
    await expect(page).toHaveURL(/\/chat\/11111111-1111-4111-8111-111111111111$/);

    // The conversation scrolls inside the shell; the page itself never does
    const scroller = page.getByTestId("chat-scroller");
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByTestId("chat-toolbar")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("chat-sources-bar")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("chat-input")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("chat-model")).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const overflow = page.getByRole("region", { name: "Table", exact: true }).last();
    expect(await overflow.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    await page.getByTestId("chat-model").click();
    await expect(page.getByTestId("chat-model-menu")).toBeVisible();
    await page.keyboard.press("Escape");

    // History is a sidebar on a wide screen and a drawer on a narrow one
    if (width < 768) {
      await expect(page.getByTestId("chat-sidebar")).toBeHidden();
      await page.getByTestId("chat-history-open").click();
    }
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    await page.getByTestId("chat-new").click();
    await expect(page.getByTestId("chat-assistant-message")).toHaveCount(0);
    await expect(page.getByTestId("chat-source-picker")).toBeVisible();
    if (width < 768) await expect(page.getByTestId("chat-sidebar")).toBeHidden();

    // A chat opened by its address still has a way back to the library at either width
    await page.getByTestId(width < 768 ? "chat-back-compact" : "chat-back").click();
    await expect(page).toHaveURL(/:\d+\/$/);
  });
}
