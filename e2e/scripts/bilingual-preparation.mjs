import { chromium, expect } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const name = `.bilingual-check-${process.pid}.tsx`;
const harness = fileURLToPath(new URL(`../../packages/web/${name}`, import.meta.url));
const origin = "http://localhost:3033";
await writeFile(harness, `
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
import { trpc } from "./src/trpc.ts";
import { BilingualPreparation } from "./src/components/BilingualPreparation.tsx";
import "./src/styles.css";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const client = trpc.createClient({ links: [httpLink({ url: "/bilingual-test-trpc" })] });
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(
  <trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><BrowserRouter>
    <BilingualPreparation bookId="book" chapterId="chapter" chapterIndex={3} translationKey="German" position={() => 4500} onOpen={() => { document.body.dataset.opened = "yes"; }} />
  </BrowserRouter></QueryClientProvider></trpc.Provider>
);
`);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [], mutations = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let status = { variantId: "variant", legacyAudio: true, convertBlocked: "Finish or stop original narration before converting its recording", current: false, pairs: 0, matched: 0, linked: 0, pairJob: null, linkJob: null, busy: false, estimatedInputTokens: 0, batches: 0, linkError: null };
  await page.route("**/bilingual-test-trpc/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const procedure = url.pathname.split("/").at(-1);
    const input = request.method() === "POST" ? request.postDataJSON() : JSON.parse(url.searchParams.get("input") ?? "null");
    let data;
    switch (procedure) {
      case "bilingual.status": data = status; break;
      case "models.list": data = [{ id: "search", label: "Search", installed: true }]; break;
      case "models.capabilities": data = { mlx: true }; break;
      case "llmModels.list": data = [{ key: "test-model", label: "Test model", recommended: true, source: "test", contextTokens: 32000 }]; break;
      case "llmModels.getDefault": data = { resolved: "test-model" }; break;
      case "bilingual.prepare": {
        mutations.push(input);
        if (input.stage === "pairs") status = { ...status, current: true, pairs: 3, matched: 2, estimatedInputTokens: 500, batches: 1 };
        else status = { ...status, busy: true, linkJob: { status: "running", done: 0, total: 1, error: null } };
        data = { runId: "run" }; break;
      }
      case "bilingual.cancel": mutations.push(input); status = { ...status, busy: false, linkJob: { status: "cancelled", error: null } }; data = null; break;
      case "bilingual.convertAudio": mutations.push(input); status = { ...status, legacyAudio: false }; data = { converted: 2 }; break;
      case "bilingual.position": expect(input.ms).toBe(4500); data = { ms: 1200 }; break;
      default: throw new Error(`Unexpected call ${procedure}`);
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) });
  });
  await page.route("**/bilingual-control-check", (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/${name}"></script></body></html>` }));
  await page.goto(`${origin}/bilingual-control-check`);
  await page.locator("summary").click();
  await expect(page.getByRole("button", { name: "Pair sentences", exact: true })).toBeEnabled();
  const conversion = page.getByRole("button", { name: "Convert recordings for accurate seeking" });
  await expect(conversion).toBeDisabled();
  await expect(conversion).toHaveAttribute("title", status.convertBlocked);
  status = { ...status, convertBlocked: null };
  expect(mutations).toEqual([]);
  await expect(page.getByRole("button", { name: "Open bilingual reader" })).toBeDisabled();
  await page.getByRole("button", { name: "Pair sentences", exact: true }).click();
  await expect(page.getByRole("button", { name: "Link words", exact: true })).toBeEnabled();
  await expect(page.getByText(/roughly 500 input tokens/)).toBeVisible();
  await page.getByRole("button", { name: "Link words", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(mutations[1]).toEqual({ variantId: "variant", stage: "links", model: "test-model" });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Older MP3 recordings can jump/)).toBeVisible();
  expect(mutations).toHaveLength(3);
  await page.getByRole("button", { name: "Convert recordings for accurate seeking" }).click();
  await expect(page.getByRole("status")).toContainText("Recordings converted");
  await expect(page.getByRole("button", { name: "Convert recordings for accurate seeking" })).toHaveCount(0);
  expect(mutations[3]).toEqual({ variantId: "variant" });
  await page.setViewportSize({ width: 393, height: 852 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await page.getByRole("button", { name: "Open bilingual reader" }).click();
  await expect(page).toHaveURL(/books\/book\/read\?chapter=3&with=German&t=1200/);
  expect(await page.locator("body").getAttribute("data-opened")).toBe("yes");
  expect(mutations).toHaveLength(4);
  expect(errors).toEqual([]);
  console.log("Preparation controls: explicit local/model actions, cost estimate, stop, explicit legacy audio conversion, narrow layout and passage-preserving navigation passed (mock API, no paid calls)");
} finally {
  await browser.close();
  await rm(harness, { force: true });
}
