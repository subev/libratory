# Design Brief: OCR engine comparison and language packs

For the designer. The engineering plan is `tasks/ocr-text-layer.md` — read it if you want the
reasoning, but this brief is self-contained. The design language is `packages/web/src/styles.css`
and `packages/web/src/components`; the screen this lives in is
`packages/web/src/components/ExtractModal.tsx`.

## The product, in one paragraph

Libratory is a local-first macOS app that turns PDFs into audiobooks you can read along with —
the page on screen, the voice reading it, the words highlighting as they are spoken. It runs
entirely on the user's own machine. The user is a power user who wants control and visibility, not
a wizard that decides for them.

## The problem

Some uploaded PDFs are scans — photographs of pages, with no text in them at all. Before such a book
can be read or narrated, the app has to OCR it. There are two engines, and choosing between them is a
genuine trade the user has to understand:

| | Tesseract | Surya |
|---|---|---|
| Speed | **~1 second a page** | ~10x slower |
| Read-along | **word by word** | a paragraph at a time |
| Flat, clean scan | good | good |
| Photographed, curled, faded or skewed page | **degrades badly** | **still accurate** |

Neither is better. These are measured, not estimates:

- A flat Bulgarian scan: Tesseract 1.9s, essentially correct.
- A *photographed* Bulgarian page, same language: Tesseract 8.7s with the right-hand margin turning
  to nonsense; Surya 70s and near-perfect.

The trap is that both wrong choices are easy. Someone picking on speed gets garbage from a phone
photo. Someone picking the "better" engine on a clean scan throws away word-by-word highlighting for
no gain. **The language is not the signal — the condition of the page is.** A design that lets
someone choose well without knowing any of the above is the goal.

## What to design

A panel inside the existing "Extract…" modal, with two related jobs.

### 1. Try one page

Let someone test a single page before committing an engine to a 300-page book.

**The user picks the page.** Not us. Page 1 is a cover, page 2 a title page, and neither says anything
about how the body reads. Default to somewhere past the front matter and make moving it easy — the
user wants to aim at the *bad* page: the photographed one, the faded one, the one with a table.

**Three panes: the rendered page image, the Tesseract result, the Surya result.** The image is not
decoration and not optional. Without it neither transcription can be judged — a reader who cannot see
what the page says cannot tell which result is right, and on a Cyrillic page in an unfamiliar
orthography that is not hypothetical. It is also the cheapest pane to produce.

**The two results arrive an order of magnitude apart.** Tesseract lands in about a second. Surya takes
about a minute. The user must be able to read Tesseract's result, judge it against the image, and
choose it, *without waiting for a Surya run they have already decided against*. Per-engine progress,
and a pane still working must not read as a pane that is broken.

**Tesseract reports an average confidence figure** (a percentage). It is genuinely useful — it is how
the app later suggests re-running with Surya. Surface it, but do not let it read as a score in a
contest: Surya reports nothing comparable, and an empty slot beside a number looks like a loss.

**Choosing an engine here sets it for the book.** That commitment should be unmistakable.

### 2. Getting a language pack, without leaving

Tesseract needs a data pack per language. The app ships English only; every other language is a
4–15 MB download (French 4.0, German 8.6, Bulgarian 8.8, Russian 15.3). The app detects the *script*
of the sampled page automatically, so it can usually name the language before the user does.

The sequence that has to work inside this modal:

1. Script detection says Cyrillic (or Latin, Han, …).
2. The language selector preselects the plausible language, showing whether its pack is installed.
3. If it is not: a control naming the language and its exact size — *Bulgarian, 8.8 MB* — that
   downloads in place, with progress.
4. When it finishes, that language is selected and the comparison above can be run **immediately**.

Step 4 is the point. Having to close and reopen the modal to pick up a pack that just landed is the
failure this design exists to prevent — the reward for downloading is being able to try it, now.

The full list is 125 languages. The detected one is right most of the time; the other 124 have to be
reachable without taking over the layout. With no network, an uninstalled pack should say why it
cannot be fetched rather than failing on click.

## Constraints

- Reuse the existing design language — tokens in `styles.css`, patterns in `components`. No new
  colour system.
- Light and dark both.
- It lives **inside an existing modal**, so it cannot be full-bleed. Three panes of prose plus an
  image in a constrained width is the central problem: solve the narrow case honestly rather than
  assuming a wide window.
- The text panes hold a full page of prose. Readable, scrollable, and compared line-for-line if you
  can manage it.
- Long words, Cyrillic and CJK must not break the layout.
- This is a prerequisite step, not the point of the app. It should feel like a competent detour, not
  a destination.

## Questions for you

1. Three columns, or the image pinned with the two results stacked or tabbed? The narrow width makes
   this the real decision.
2. How do you show a pane that has not finished, for a full minute, without it reading as broken or
   as an error?
3. How do you convey the trade — speed and word-highlighting against accuracy on damaged pages — at a
   glance, without a paragraph of explanation nobody reads?
4. How much room does the language pack control deserve? It is a prerequisite, not the subject of the
   screen — but for someone with a French scan it is the only thing that matters for the next thirty
   seconds.
5. Is there a way to make "the page is photographed, not scanned" visible in the image pane itself?
   That single fact predicts the right answer better than anything else on screen.
