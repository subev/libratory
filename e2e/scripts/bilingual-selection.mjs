import { chromium, expect } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const name = `.bilingual-selection-check-${process.pid}.tsx`;
const harness = fileURLToPath(new URL(`../../packages/web/${name}`, import.meta.url));
const origin = "http://localhost:3033";
await writeFile(harness, `
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink } from "@trpc/client";
import { trpc } from "./src/trpc.ts";
import { BilingualSelection } from "./src/components/BilingualSelection.tsx";
import "./src/styles.css";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const client = trpc.createClient({ links: [httpLink({ url: "/bilingual-test-trpc" })] });
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root");
createRoot(root).render(
  <trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><BrowserRouter>
    <BilingualSelection bookId="book" chapterIds={["complete", "missing", "partial", "unavailable"]} translationKey="German" onClose={() => { document.body.dataset.closed = "yes"; }} />
  </BrowserRouter></QueryClientProvider></trpc.Provider>
);
`);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [], mutations = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = { variantId: "variant", current: true, pairs: 3, matched: 3, linked: 3, pairJob: null, linkJob: null, busy: false, estimatedInputTokens: 0, batches: 0, linkError: null };
  const rows = [
    { chapterId: "complete", index: 0, title: "Complete", available: true, status: { ...base } },
    { chapterId: "missing", index: 1, title: "Missing", available: true, status: { ...base, variantId: "missing-variant", current: false, linked: 0, pairs: 0 } },
    { chapterId: "partial", index: 2, title: "Partial", available: true, status: { ...base, variantId: "partial-variant", linked: 1, batches: 1, estimatedInputTokens: 500, linkJob: { status: "failed", error: "Previous failure" } } },
    { chapterId: "unavailable", index: 3, title: "Untranslated", available: false, status: null },
  ];
  let linksAttempt = 0;
  await page.route("**/bilingual-test-trpc/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const procedure = url.pathname.split("/").at(-1);
    const input = request.method() === "POST" ? request.postDataJSON() : JSON.parse(url.searchParams.get("input") ?? "null");
    let data;
    switch (procedure) {
      case "bilingual.selection": data = rows; break;
      case "models.list": data = [{ id: "search", label: "Search", installed: true }]; break;
      case "models.capabilities": data = { mlx: true }; break;
      case "llmModels.list": data = [{ key: "test-model", label: "Test model", recommended: true, source: "test", contextTokens: 32000 }]; break;
      case "llmModels.getDefault": data = { resolved: "test-model" }; break;
      case "bilingual.prepareSelection": {
        mutations.push(input);
        expect(input.chapterIds).toEqual(["complete", "missing", "partial", "unavailable"]);
        if (input.stage === "pairs") rows[1].status = { ...rows[1].status, busy: true, pairJob: { status: "queued", done: 0, total: 0, error: null } };
        else {
          linksAttempt++;
          rows[2].status = { ...rows[2].status, busy: linksAttempt > 1, linkJob: { status: linksAttempt > 1 ? "running" : "failed", done: 1, total: 3, error: linksAttempt > 1 ? null : "Queue unavailable" } };
        }
        data = [{ chapterId: input.stage === "pairs" ? "missing" : "partial", queued: input.stage === "pairs" || linksAttempt > 1, error: input.stage === "links" && linksAttempt === 1 ? "Queue unavailable" : null }];
        break;
      }
      case "bilingual.cancelSelection": {
        mutations.push(input);
        for (const row of rows) if (row.status?.busy) {
          row.status.busy = false;
          for (const field of ["pairJob", "linkJob"]) if (["running", "queued"].includes(row.status[field]?.status)) row.status[field] = { ...row.status[field], status: "cancelled" };
        }
        data = { success: true }; break;
      }
      default: throw new Error(`Unexpected call ${procedure}`);
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) });
  });
  await page.route("**/bilingual-control-check", (route) => route.fulfill({ contentType: "text/html", body: `<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/${name}"></script></body></html>` }));
  await page.goto(`${origin}/bilingual-control-check`);
  await expect(page.getByTestId("bilingual-selection-chapter")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Pair missing sentences (1)", exact: true })).toBeEnabled();
  await expect(page.getByText(/roughly 500 input tokens, up to 8,192 output tokens/)).toBeVisible();
  expect(mutations).toEqual([]);
  await page.getByRole("button", { name: "Pair missing sentences (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop preparation (1)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pair missing sentences (0)", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Stop preparation (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop preparation (1)", exact: true })).toHaveCount(0);
  await expect(page.getByText("3 sentence groups · 3/3 with word links")).toBeVisible();
  await page.getByRole("button", { name: "Link remaining words (1)", exact: true }).click();
  await expect(page.getByRole("alert", { name: "" }).filter({ hasText: "Queue unavailable" })).toBeVisible();
  expect(mutations).toHaveLength(3);
  expect(mutations[2]).toMatchObject({ model: "test-model", stage: "links" });
  await page.getByRole("button", { name: "Link remaining words (1)", exact: true }).click();
  await expect(page.getByText("running · 1/3")).toBeVisible();
  await page.getByRole("button", { name: "Stop preparation (1)", exact: true }).click();
  await expect(page.getByText("3 sentence groups · 1/3 with word links · stopped")).toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  await page.getByTestId("bilingual-selection-chapter").first().getByRole("link", { name: "Read", exact: true }).click();
  await expect(page).toHaveURL(/books\/book\/read\?chapter=0&with=German/);
  expect(mutations).toHaveLength(5);
  expect(errors).toEqual([]);
  console.log("Selection controls: mixed readiness, explicit model/cost, stop, partial failure/retry, preserved completed groups, narrow layout and reader links passed (mock API, no paid calls)");
} finally {
  await browser.close();
  await rm(harness, { force: true });
}
