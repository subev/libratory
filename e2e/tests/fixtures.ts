import { test as base } from "@playwright/test";
import { trpcMutation, purgeProfile } from "./helpers/trpc.ts";
import { registerFakeLlm } from "./helpers/fake-llm-registry.ts";
import { startFakeLlm, FAKE_REPLY, FAKE_CITED_REPLY } from "../fixtures/fake-llm.mjs";

export { FAKE_REPLY, FAKE_CITED_REPLY };
export { FAKE_MODEL_KEY, FAKE_NOTOOLS_KEY, FAKE_TINY_KEY } from "./helpers/fake-llm-registry.ts";
export { API_URL } from "./helpers/env.ts";
export { createApiBook, uploadFixtureBook, FIXTURE_PDF, FIXTURE_CONTAINER } from "./helpers/books.ts";

// Every test runs inside a fresh profile so the user's real library is never
// touched; the profile and everything it accumulated is deleted afterwards.
export const test = base.extend<{ profileId: string }, { fakeLlm: void }>({
  profileId: async ({ request }, use, testInfo) => {
    const profile = await trpcMutation(request, "profiles.create", {
      name: `e2e ${testInfo.workerIndex} ${Date.now()}`,
    });
    await use(profile.id);
    await purgeProfile(request, profile.id).catch((err) => {
      console.warn(`e2e profile ${profile.id} left behind: ${err}`);
    });
  },
  page: async ({ page, profileId }, use) => {
    await page.addInitScript((id: string) => localStorage.setItem("profile.id", id), profileId);
    await use(page);
  },
  // Worker-scoped and requested by name only: tests that need the stub destructure it as
  // `fakeLlm: _fakeLlm`, which Playwright still reads as a request for `fakeLlm`.
  fakeLlm: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here; this fixture depends on nothing
    async ({}, use) => {
      const stub = await startFakeLlm(0);
      const restore = await registerFakeLlm(`http://localhost:${stub.port}`);
      await use();
      await restore();
      await stub.close();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
