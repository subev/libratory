import fs from "node:fs/promises";
import { test, expect } from "./fixtures.ts";
import { trpcMutation } from "./helpers/trpc.ts";
import { ENV_PATH } from "./helpers/env.ts";

// Text preparation is milliseconds of regex, so it is the one pool that is reliably idle
// mid-suite — every other one can legitimately be busy while these tests run.
const POOL = "prep";

test("settings: a worker concurrency change lands in .env and survives a reopen", async ({ page, request }) => {
  const snapshot = await fs.readFile(ENV_PATH, "utf8");

  try {
    await page.goto("/");
    await page.getByTestId("settings-gear").click();
    await expect(page.getByTestId("settings-workers")).toBeVisible();

    const select = page.getByTestId(`settings-worker-select-${POOL}`);
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("2");
    await select.selectOption("4");

    await expect
      .poll(async () => await fs.readFile(ENV_PATH, "utf8"))
      .toContain("WORKER_CONCURRENCY_PREP=4");

    await page.goto("/");
    await page.getByTestId("settings-gear").click();
    await expect(page.getByTestId(`settings-worker-select-${POOL}`)).toHaveValue("4");
  } finally {
    // The server keeps the value in memory and in its running pool, so put both back before
    // restoring the file the suite's other tests read
    await trpcMutation(request, "workers.setConcurrency", { pool: POOL, concurrency: 2 }).catch(() => {});
    if ((await fs.readFile(ENV_PATH, "utf8")) !== snapshot) await fs.writeFile(ENV_PATH, snapshot);
  }
});
