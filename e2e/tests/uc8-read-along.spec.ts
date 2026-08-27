import type { Page } from "@playwright/test";
import { test, expect, createApiBook, uploadFixtureBook, FIXTURE_CONTAINER } from "./fixtures.ts";

// pdf.js sizes the canvas before it paints, so a page that failed to render is not a missing box —
// it is a correctly sized empty one, which is what Safari drew and what toBeVisible() cannot see.
// Ink is the only witness: a canvas that never rendered is transparent, and one that rendered
// nothing is flat white, so a dark opaque pixel is the single thing neither of them has.
function printPainted(page: Page) {
  return page.getByTestId("reader-page").first().locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0) return false;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) return true;
    }
    return false;
  });
}

test("UC8: read along is offered only once a chapter is on a page", async ({ page, request, profileId }) => {
  // Written rather than extracted, so there is no print behind it — the one case with nothing to open
  await createApiBook(request, profileId, {
    title: "Nothing Spoken Yet",
    chapters: [{ title: "Only text", text: "A chapter that has never been synthesized." }],
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Nothing Spoken Yet" }).click();

  const entry = page.getByTestId("book-read-link");
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute("title", /No chapter is on a page yet/);
});

test("UC8: a book sent as a file reads along from the file itself", async ({ page }) => {
  // Nothing here touches the library or the server's own documents: the pages, the narration and
  // the timings all come out of the zip, which is the whole claim the format makes.
  await page.goto("/open");
  await page.locator("input[type=file]").setInputFiles(FIXTURE_CONTAINER);

  await expect(page.getByTestId("reader-page").first()).toBeVisible();
  await expect.poll(() => printPainted(page)).toBe(true);
  await expect(page.getByTestId("cue-rect").first()).toBeVisible();
  await expect(page.getByTestId("reader-granularity")).toHaveText("word");
  await expect(page.locator("audio")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByTestId("reader-chapter").locator("option")).toHaveCount(3);
});

test("UC8: the print still paints where Map.prototype.getOrInsertComputed is missing", async ({ page }) => {
  // Removing the pair before any script runs puts preparePdfWorker on its blob branch, which is
  // the entry only Safari ever takes and so the one nothing else here would load. Chromium's
  // worker realm keeps the native method — unreachable from here — so this does not prove the
  // polyfill works; map-get-or-insert.test.ts does that. What it proves is the part no unit test
  // can: that a blob module worker with a top-level await and a dynamic import really does start
  // and render in a browser.
  await page.addInitScript(() => {
    for (const proto of [Map.prototype, WeakMap.prototype]) {
      const target = proto as unknown as Record<string, unknown>;
      delete target.getOrInsert;
      delete target.getOrInsertComputed;
    }
  });
  const failures: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });

  await page.goto("/open");
  await page.locator("input[type=file]").setInputFiles(FIXTURE_CONTAINER);

  await expect(page.getByTestId("reader-page").first()).toBeVisible();
  await expect.poll(() => printPainted(page)).toBe(true);
  expect(failures.filter((text) => text.includes("PDF page render failed"))).toEqual([]);
});

test("UC8: an EPUB with no read-along layer says so instead of failing obscurely", async ({ page }) => {
  await page.goto("/open");
  await page.locator("input[type=file]").setInputFiles({
    name: "plain.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.from("PK\x05\x06" + "\0".repeat(18), "binary"),
  });
  await expect(page.getByTestId("reader-open-error")).toContainText(/no read-along layer/);
});

// marker_single and Kokoro both run for real here — full tier only (pnpm e2e:full)
test.describe("read along on the page", { tag: "@slow" }, () => {
  test("UC8: the spoken sentence is highlighted on the PDF page, and tapping one seeks to it", async ({ page }) => {
    test.setTimeout(20 * 60_000);

    await uploadFixtureBook(page);
    await page.getByTestId("extract-chapters").click();
    await expect(page.getByTestId("chapter-row").first()).toBeVisible({ timeout: 10 * 60_000 });

    // Before a word is spoken the chapter's pages already open — with nothing marked on them,
    // and saying which of the reasons applies
    await page.getByTestId("chapter-open").first().click();
    await page.getByTestId("view-tab-pages").click();
    await expect(page.getByTestId("reader-page").first()).toBeVisible();
    await expect(page.getByTestId("pages-unmarked")).toContainText("Synthesize");
    await expect(page.getByTestId("cue-rect")).toHaveCount(0);
    await expect(page.getByTestId("chapter-read-along-off")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chapter-modal")).toBeHidden();

    // …and so does the full reader, on the same pages: the print is the book's, not the narration's.
    // Nothing here waits on audio, so nothing here may be withheld until there is some.
    await expect(page.getByTestId("book-read-link")).toHaveAttribute("title", /synthesize a chapter/);
    await page.getByTestId("book-read-link").click();
    await expect(page.getByTestId("reader-page").first()).toBeVisible();
    await expect(page.getByTestId("reader-text-mode")).toContainText("hasn't been narrated yet");
    await expect(page.getByTestId("cue-rect")).toHaveCount(0);
    await expect(page.getByTestId("reader-play")).toBeDisabled();
    // The whole page too, not just the cropped column — both are the PDF, drawn the same way
    await page.getByTestId("reader-view-page").click();
    await expect(page.getByTestId("reader-page").first()).toBeVisible();
    // Back deep-links to the chapter it was reading, which opens the modal over the book page
    await page.getByTestId("reader-back").click();
    await expect(page.getByTestId("chapter-modal")).toBeVisible();

    // Narrating a chapter with its own modal open marks the pages as soon as the run lands. The
    // modal outlives the synthesis, so nothing it holds may be left waiting for a reload.
    await page.getByTestId("view-tab-pages").click();
    await expect(page.getByTestId("pages-unmarked")).toBeVisible();
    await page.getByTestId("chapter-synthesize").click();
    await expect(page.getByTestId("cue-rect").first()).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByTestId("pages-unmarked")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chapter-modal")).toBeHidden();

    await page.getByTestId("open-synthesize").click();
    await page.getByTestId("synthesize-start").click();
    // Every chapter, not just the first to finish: the reader opens on one of them
    await expect(page.getByTestId("chapter-play")).toHaveCount(3, { timeout: 5 * 60_000 });

    await page.getByTestId("book-read-link").click();

    // Kokoro reports per-word timings, so a cue is a sentence rather than a whole chunk
    await expect(page.getByTestId("reader-granularity")).toHaveText("word");

    const rect = page.getByTestId("cue-rect").first();
    await expect(rect).toBeVisible();

    const audioTime = () => page.locator("audio").evaluate((el: HTMLAudioElement) => el.currentTime);
    expect(await audioTime()).toBe(0);

    // Page view, so a rect's page coordinates are the host element's own coordinates
    await page.getByTestId("reader-view-page").click();
    await expect(page.getByTestId("cue-rect").first()).toBeVisible();

    const target = await page.evaluate(async () => {
      const bookId = location.pathname.split("/")[2];
      const manifest = await (await fetch(`/read/book/${bookId}/book.json`)).json();
      const chapter = manifest.chapters.find((entry: { audio: string | null }) => entry.audio);
      const doc = await (await fetch(chapter.cues)).json();
      const cue = doc.cues.find(
        (entry: { t: number[]; r?: number[][]; wr?: number[][][] }) =>
          entry.t[0] > 0 && entry.r?.length && entry.wr?.some((rects) => rects.length),
      );
      if (!cue) return null;

      const word = cue.w[cue.wr.findIndex((rects: number[][]) => rects.length)];
      return { startMs: cue.t[0] as number, rect: cue.r[0] as number[], wordMs: (word[0] + word[1]) / 2 };
    });
    expect(target).not.toBeNull();

    const [pageIndex, x, y, rectWidth, rectHeight] = target!.rect;
    const host = page.locator(`[data-page-index="${pageIndex}"] [data-testid="reader-page"]`);
    const box = (await host.boundingBox())!;
    await host.click({
      position: {
        x: (box.width * (x + rectWidth / 2)) / 10_000,
        y: (box.height * (y + rectHeight / 2)) / 10_000,
      },
    });
    await expect.poll(audioTime).toBeCloseTo(target!.startMs / 1000, 1);

    // Mid-word, the word being spoken is marked on the page inside its sentence
    await page.locator("audio").evaluate((el: HTMLAudioElement, ms: number) => { el.currentTime = ms / 1000; }, target!.wordMs);
    await expect(page.getByTestId("cue-word-rect").first()).toBeVisible();

    // A4 pages are too wide to read whole on a phone, and the reader says so
    await page.getByTestId("reader-width-phone").click();
    await expect(page.getByTestId("reader-too-small")).toBeVisible();
    await page.getByTestId("reader-width-full").click();

    // Hovering the print rings the sentence a click would seek to. Only the ring: the reader has
    // no chunk list for the tint to answer to — that binding belongs to the modal
    await host.hover({
      position: {
        x: (box.width * (x + rectWidth / 2)) / 10_000,
        y: (box.height * (y + rectHeight / 2)) / 10_000,
      },
    });
    await expect(page.getByTestId("cue-ring-rect").first()).toBeVisible();
    await expect(page.getByTestId("cue-linked-rect")).toHaveCount(0);

    // Space is play/pause, so nobody has to go looking for the button. Tapping a sentence above
    // already started the narration, so the state to assert against is whatever that left.
    const paused = () => page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused);
    const wasPaused = await paused();
    await page.locator("body").press("Space");
    await expect.poll(paused).toBe(!wasPaused);
    await page.locator("body").press("Space");
    await expect.poll(paused).toBe(wasPaused);

    // A standing preference, not a per-chapter one. Loading another file resets the element's rate
    // to defaultPlaybackRate, so a chapter change used to drop back to 1x with the picker still
    // claiming otherwise.
    const rate = () => page.locator("audio").evaluate((el: HTMLAudioElement) => el.playbackRate);
    await page.getByTestId("reader-speed").selectOption("1.5");
    await expect.poll(rate).toBe(1.5);

    // The chapter that was reading rolls on to the next narrated one when its audio ends
    const chapterPicker = page.getByTestId("reader-chapter");
    const leaving = await chapterPicker.inputValue();
    await page.locator("audio").evaluate(async (el: HTMLAudioElement) => {
      el.currentTime = el.duration - 0.3;
      await el.play();
    });
    await expect(chapterPicker).not.toHaveValue(leaving, { timeout: 30_000 });
    expect(await page.locator("audio").evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
    expect(await rate()).toBe(1.5);

    // Back lands on the chapter being read, not at the top of the table
    const rolled = await chapterPicker.evaluate((el: HTMLSelectElement) =>
      el.selectedOptions[0].text.replace(/^\d+\.\s*/, ""),
    );
    await page.getByTestId("reader-back").click();
    await expect(page.getByTestId("chapter-modal")).toContainText(rolled);

    // One player for one file: the chapter's audio has a single control in the modal
    await expect(page.locator('[data-testid="chapter-modal"] audio')).toHaveCount(1);

    // The modal reads along on the same pages, and a chunk preview lights the print it became
    await expect(page.getByTestId("view-tab-pages")).toBeVisible();
    await expect(page.getByTestId("cue-rect").first()).toBeVisible();
    await page.getByRole("button", { name: /^Chunk 1$/ }).hover();
    await expect(page.getByTestId("cue-linked-rect").first()).toBeVisible();

    // Editing the text unbinds the narration from the print. The audio outlives the edit, so the
    // pages must stop offering sentences to tap the moment the save lands, not on the next reload.
    await page.getByTestId("view-tab-pages").click();
    await page.getByTestId("chapter-edit").click();
    await page.getByTestId("chapter-edit-text").fill("Rewritten by hand, so the print says something else now.");
    await page.getByTestId("chapter-edit-save").click();
    await expect(page.getByTestId("pages-unmarked")).toContainText("edited after extraction");
    await expect(page.getByTestId("cue-rect")).toHaveCount(0);
    await expect(page.getByTestId("chapter-read-along-off")).toBeVisible();
  });
});

