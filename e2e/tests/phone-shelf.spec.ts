import fs from "node:fs/promises";
import { test, expect } from "./fixtures.ts";
import { trpcQuery, trpcMutation } from "./helpers/trpc.ts";
import { ENV_PATH } from "./helpers/env.ts";

test("phone: the Phone page opens from the library, and the shelf gives a stranger nothing", async ({ page, request }) => {
  await page.goto("/");
  await page.getByTestId("phone-page-link").click();
  await expect(page).toHaveURL(/\/phone$/);
  await expect(page.getByTestId("pairing-card")).toBeVisible();
  await expect(page.getByTestId("phones-card")).toContainText("No phone has scanned the code yet");
  await expect(page.getByTestId("shelf-table")).toContainText("Nothing yet");

  // The shelf routes answer, and answer nothing to a stranger — unless the server has a public
  // shelf, which is the one listing anyone may read
  const bare = await request.get("/shelf");
  if (bare.status() === 200) expect(await bare.json()).toMatchObject({ public: true, device: null });
  else expect(bare.status()).toBe(401);
  expect((await request.get("/shelf", { headers: { authorization: "Bearer not-a-key" } })).status()).toBe(401);
  expect((await request.get("/shelf/pair/not-a-code")).status()).toBe(404);
  expect((await request.post("/shelf/pair", { data: { token: "not-a-code", name: "e2e" } })).status()).toBe(404);
});

test("phone: sharing the shelf mints a code with the link under it, and stopping takes it away", async ({ page, request }) => {
  const snapshot = await fs.readFile(ENV_PATH, "utf8");
  const before = await trpcQuery(request, "phone.pairingCode");
  if (before.loopbackOnly || !before.reachable) {
    test.skip(true, "the dev server listens on this machine only, so there is no code to mint");
    return;
  }
  if (before.access === "all") {
    test.skip(true, "NETWORK_ACCESS=all is a deliberate server setting; the test will not narrow it");
    return;
  }

  try {
    await page.goto("/phone");
    const card = page.getByTestId("pairing-card");
    if (before.access === "shelf") {
      await card.getByTestId("stop-sharing").click();
      await expect(card.getByTestId("not-shared-notice")).toBeVisible();
    }
    await card.getByTestId("share-shelf").click();
    await expect(card.getByTestId("pairing-qr")).toBeVisible();
    await expect(card.getByTestId("pairing-link")).toContainText(/#s=http.*&t=/);
    expect(await fs.readFile(ENV_PATH, "utf8")).toContain("NETWORK_ACCESS=shelf");

    await card.getByTestId("stop-sharing").click();
    await expect(card.getByTestId("not-shared-notice")).toBeVisible();
    await expect(card.getByTestId("pairing-qr")).toHaveCount(0);
    expect(await fs.readFile(ENV_PATH, "utf8")).toContain("NETWORK_ACCESS=none");
  } finally {
    // Leave the server sharing exactly what it shared before, in memory and on disk
    await trpcMutation(request, "phone.setNetworkAccess", { access: before.access }).catch(() => {});
    if ((await fs.readFile(ENV_PATH, "utf8")) !== snapshot) await fs.writeFile(ENV_PATH, snapshot);
  }
});
