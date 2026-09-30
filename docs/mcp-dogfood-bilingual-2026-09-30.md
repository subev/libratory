# MCP dogfood: bilingual EPUB of Frankenstein, Letter 1 (2026-09-30)

Task: through the MCP tools only, turn Letter 1 of *Frankenstein* (Demo profile) into an
`epub-bilingual` export (English + Bulgarian) and save it to `~/Downloads`. Choices made with the
user: reuse the existing Bulgarian translation, Bulgarian narration via Cartesia (fell back to none
when the account ran out of credits), word links on.

Call sequence: `list_books` ×2 → `get_book` → `get_chapter` / `list_voices` / `get_capabilities` →
`prepare_bilingual pairs` → `synthesize_book` (Cartesia, failed) → `wait_for_book audio` →
`get_book logsAfter` → `prepare_bilingual links` → 13 × `update_chapter selected:false` →
`get_book logsAfter` (polling) → `export_book epub-bilingual` → … (see Outcome).

Findings are ranked by how much they cost an agent. Each one comes from a response in this session.

## High: wrong or missing signals

1. **`get_book` has no `bilingual` field, but `export_book` tells the agent to read it there.**
   `export_book`'s description says "get_book's bilingual field lists the unpaired ones". `get_book`
   never returned it (three calls). Only the *summary* returned by mutating tools (`prepare_bilingual`,
   `synthesize_book`) carries `bilingual`. The one call documented as "everything about one book" is
   missing the state the export depends on.

2. **A failed variant narration reads as success.** `synthesize_book language:Bulgarian` with a
   Cartesia voice failed about a second later (HTTP 402, quota). Then `wait_for_book until:"audio"`
   returned `satisfied: true`. The variant summary showed `withAudio: 0, narrating: 0` with no
   `failed` count. The only trace was the raw provider JSON in `latestLog.message`. An agent that
   trusts `satisfied` goes on to export with `targetAudio: true` and gets a confusing refusal, or
   worse, an export with no audio.
   - `wait_for_book` stages only consider the original lane, and none of them covers bilingual work.
   - variant summaries need an audio `failed` count and error, like `chapters.failed` for the original.

3. **No preflight for Cartesia credits.** ElevenLabs is preflighted against its quota (AGENTS.md);
   Cartesia is not. The job was accepted, a lane voice was stored, and it failed on the first chunk:
   "requires approximately 349 credits but you have 125 remaining". The agent could not have known
   before spending the call, and neither could the user. The tool response gives no cost estimate for
   a metered voice either.

4. **`synthesize_book` persists the lane voice even when narration fails at once.** The Bulgarian lane's
   narrator is now Cartesia Ivana, a voice this account cannot pay for. The UI and the next agent will
   pick it up. This is arguably intended ("setting the lane's own narrator first"), but a refused run
   leaving the setting behind is surprising.

## Medium: missing affordances that force workarounds

5. **`export_book` has no `chapterIds`.** Exporting one chapter meant 13 `update_chapter
   selected:false` calls, which mutated the user's book (selection is shared with the UI), and 13
   more to restore it. `prepare_bilingual`, `synthesize_book`, `translate_book` and
   `cleanup_chapters` all take `chapterIds`; `export_book` and `assemble_book` do not. Either add
   `chapterIds` there, or accept a list in `update_chapter`.

6. **No way to wait for bilingual work.** `prepare_bilingual` says "poll get_book's bilingual field",
   which does not exist (see 1). The only progress signal is log lines ("linked batch 3/8") via
   `get_book logsAfter`, and each such poll re-sends the entire chapter list (about 4k tokens for 14
   chapters). A `wait_for_book until:"bilingual"` stage (with `language`) would remove the loop.

7. **`logsAfter` cannot be asked for without the whole book.** Polling a log should cost a few hundred
   tokens, not 4k. Suggest `get_book … logsOnly` or a `fields` filter.

8. **Translated text is not readable through MCP.** `get_chapter` returns only the original. An agent
   asked to check a translation before spending on narration or links cannot. A `language` param on
   `get_chapter` would fix it.

9. **Which chapters a variant covers is not said.** `variants[].chapters` gives counts
   (`total: 1, done: 1`) but not which chapter. I only learned it was Letter 1 from the side effect of
   calling `prepare_bilingual`, whose summary listed the other 13 as `untranslated`.

10. **`bilingual.untranslated` / `unpaired` entries carry `index` + `title` but no chapter `id`.** Every
    follow-up tool takes ids, so the agent has to join against `get_book`'s chapter list.

11. **Paid stages give no cost estimate.** `prepare_bilingual stage:"links"` says "a few cents per
    chapter" in its description, but the response carries no estimate or actual spend. The same holds
    for `synthesize_book` on a metered voice.

## Low: noise and inconsistency

12. **`bilingual[].language` changed shape between calls:** `"Bulgarian"` before pairing, `"bg"`
    after. Pick one (the ISO code, with `key` already holding the name).

13. **`list_books` with a `query` that matches nothing still returns every profile and all 25
    folders** (about 2.5k tokens) and says nothing about other profiles. Frankenstein was in *Demo*. A
    zero-hit query should either search across profiles or say "0 here; N matches in profile Demo".

14. **`profiles[].current` means "the profile this listing is for"**, not the connection's profile. It
    flipped to Demo when `profile: "Demo"` was passed. Fine once known, but the name suggests the
    session's profile.

15. **Every mutating tool returns the full book summary.** That is about 2k tokens per call, including
    the same 13-entry `untranslated` list each time. `update_chapter` returns `{success, undo}`, which
    is the right size. `prepare_bilingual` / `synthesize_book` could return the queued count plus the
    one lane they touched.

16. **`book.language` is `null` on a plainly English book** (uploaded 2026-08-23, before detection
    landed?). Bilingual pairing worked anyway, but a stale null invites a wrong guess by the agent.

17. **Provider errors are passed through raw** (`Cartesia TTS error 402: {"error_code":…}` with a
    trailing newline) in `latestLog`. A short `error: "Cartesia: out of credits (needs ~349, has 125)"`
    on the lane would be clearer.

18. **No way to get the file out through MCP.** `export_book` / `get_book` give a server-absolute
    `outputPath` and a *relative* `downloadUrl` (`/download/document/…`) with no host. Local agents can
    copy the path; a remote agent (or the Docker install, where the path is inside the container)
    cannot do anything with either. An absolute URL, or a `save_to` path option on export, would close
    the loop.

## Found after the export

19. **Finding a book across profiles is guesswork, and the agent picked without asking.** Frankenstein
    exists in *Demo* (1818, 14 chapters) and *temp* (1888, 32 chapters). `list_books` searches one
    profile per call, so it took four calls to find both, and I committed to the first hit without
    asking the user (a behaviour mistake). The tool could have prevented it: a `query` should search
    every profile, or a zero-hit answer should say where the matches are. With one hit in the
    connection's profile and one elsewhere, the response should name both so the agent has to choose.

20. **The Bulgarian is invisible outside the Libratory reader.** The export's `ch000.xhtml` is English
    only (`lang="en"`). The translation (complete: 6,664 characters, all Cyrillic, 53/53 pairs
    matched, 1,035 word links) lives solely in `OEBPS/p2af/bilingual/<id>.json`. Apple Books or any
    generic EPUB reader shows an ordinary English book. That may be the intended design (a p2af layer
    for the iOS reader), but neither `export_book`'s description nor its result says so. An agent tells
    the user "here is your bilingual EPUB", and the user opens it and sees no Bulgarian. The user
    asked "is it translated to bulgarian though" for exactly this reason. Either render the target
    text into the XHTML as well (interleaved, or as a second spine item), or say plainly in the tool
    description and result that the second language needs the Libratory reader.

21. **`assembleQueued: true` after a document export.** The summary returned by `export_book
    epub-bilingual` said an M4B assembly was queued. None was: it went back to `false` once the
    export finished. The flag seems to read the book's assembly-pool job, not an M4B.

22. **No wait stage for exports.** `wait_for_book until:"output"` means the M4B, which already
    existed, so it could not be used to wait for the EPUB. The export took about 1 s here, but a
    Vivliostyle PDF takes minutes. The agent needs `until:"document"` or an export job id to wait on.

23. **Small copy nits.** The log says "Exporting 1 bilingual chapters". The chapter XHTML's text
    shows "Letter 1" three times (title, heading, and the chapter text's own first line) —
    probably a duplicated heading, not verified in a reader.

24. **Links exported against a recording with no word times, and nothing said so.** Letter 1's
    English audio dates from 2026-08-23 and its sync map is v1 (26 chunks, no word timings). The
    export's cues are `granularity: "chunk"`, and all 53 narration anchors are `passage`. Both readers
    underline links only for the word being spoken (`tokenAtTime` takes `word` anchors only;
    iOS `meanings(on:)` returns only the voice's word while playing). So the 1,035 paid-for links
    never light up during playback. The user opened the book and saw no links. `list_voices` reports
    `wordTiming: true` for `kokoro:af_heart`, which is true of the voice and false of this old
    recording. Neither `get_book` nor `prepare_bilingual links` nor `export_book` told the agent.
    Suggested: a per-chapter `wordTiming` fact in `get_book` (and in `bilingual`), a warning from
    `prepare_bilingual links` / `export_book` when the narrated side has no word times ("links will
    show on tap only; re-narrate chapter N for live links"), and the export's `qualityNotes` put
    into the tool result.

25. **Re-narrating drops the old audio at queue time.** `synthesize_book chapterIds:[Letter 1]` took
    `withAudio` from 14 to 13 before the new run started. It succeeded here (37 s), but a failure
    would have left a chapter that had audio with none. Keep the old file until the new one lands.

26. **Export refusals name the UI, not the tool.** "Pair current sentences first (Bilingual reading
    in the Bulgarian lane): 2. Letter 2, 3. Letter 3, 4. Letter 4 and 10 more". The real cause for an
    agent was "those chapters are selected but have no translation". The fix is to deselect them, or
    to run `translate_book` then `prepare_bilingual`, and the message names neither. It also cuts the
    list at three.

Agent-side note: I slipped out of MCP once, trying `psql` to poll the log instead of paying 4k tokens
per `get_book`. It failed on auth and I went back to MCP. That temptation is finding 7 in practice.

## What worked well

- `update_chapter` returns an `undo` payload, which is exactly what an agent needs to put things back.
- `prepare_bilingual` refuses nothing it should not, and only requests missing or stale work, so the
  calls are safe to repeat.
- The pairs stage is fast (about 10 s for 53 sentence groups) and free, and log lines are
  informative ("linked batch 3/8").
- `list_voices` exposes `wordTiming`, which is the right fact for choosing a bilingual narrator.
- `get_capabilities` answers "can I do this here" in one call.

## Outcome

- Book: Demo profile, `9eb717a1-b10c-4df3-8ecc-12abc4e2e007` (1818 text). The user chose it over
  the temp copy after the fact.
- First export (`b9f231a9…`, 00:28): its links never lit up in playback because the English audio had
  no word times (finding 24). Removed from `~/Downloads`; still listed under the book's documents.
- Second export, after re-narrating Letter 1 with `kokoro:af_heart` (37 s): `epub-bilingual`,
  Bulgarian, English audio only (Cartesia credits exhausted; the user chose no Bulgarian audio),
  document `6ef37fdc-fc86-41be-9b58-380d1f53ac9f`, 4.2 MB, at
  `~/Downloads/Frankenstein_or_The_Modern_Prometheus_bilingual_original-bulgarian_audio-original_pages_20260930_004518.epub`.
  1,344 word anchors, word-level cues, 53 matched pairs, 1,035 word links, full Bulgarian text in the
  p2af layer.
- Side effects left on the Demo book: the Bulgarian lane voice is Cartesia Ivana (finding 4). Chapter
  selection was restored to all 14.
- Spend: the DeepSeek links stage for one chapter (8 batches), a few cents. Cartesia spent nothing
  (refused).

## Suggested order of work

1. Findings 1, 2 and 6: put `bilingual` and variant audio failures in `get_book`, and give
   `wait_for_book` a variant-aware `audio` stage plus a `bilingual` stage.
2. Finding 24: warn when links are prepared or exported against audio with no word times. That is
   what made the user's first look show "no links".
3. Finding 20: make the second language visible, or say plainly that it needs the reader.
4. Finding 5: add `chapterIds` to `export_book` / `assemble_book`.
5. Finding 3: a Cartesia credit preflight, mirroring ElevenLabs.
6. Findings 7 and 15: slimmer responses (a logs-only read, a mutation result scoped to what changed).
7. Finding 19: `list_books` query across profiles.

## Round two: fixes, then the whole book

Changes made after round one, each against the finding it answers:

| Finding | Change |
| --- | --- |
| 1, 10, 12 | `get_book` carries `bilingual` per translation with `untranslated` / `unpaired` / `unlinked` chapters by id; `language` is always an ISO code (`languageCode(key)` before pairing). The summary keeps `unpaired` by id and counts the rest. |
| 2, 17 | Variants report `audioFailed` and `audioError`; `wait_for_book until:"audio"` returns `satisfied: false` naming the failed narration, and takes `language` to wait on one lane. Cartesia's 402 becomes "Cartesia is out of credits: the next chunk needs about N credits and M are left…" (`cartesiaErrorMessage`). |
| 3, 11 | Cartesia has no balance endpoint for an ordinary key (only admin keys read credit usage), so there is no true preflight. `synthesize_book` with a metered voice answers with `estimate` — the characters it will bill. |
| 5 | `export_book` takes `chapterIds`, carried in the job payload to every place the worker picked chapters by `selected` (`outputChapters` in `lib/output-readiness.ts`). |
| 6, 22 | `wait_for_book` stages `bilingual` (preparation rows queued/running, failures named) and `document` (no export queued or running; answers with the newest document). |
| 7 | `get_book logsOnly` — status and log, no chapter list. |
| 8 | `get_chapter language` reads a translation or rewrite. |
| 9 | Variants in `get_book` list `chapterIndexes`. |
| 13, 14, 19 | `list_books query` leaves the folder list out and names matches in other profiles under `elsewhere`; the description says `current` marks the listed profile. |
| 18 | `downloadUrl` is absolute, built from the Host the client used (the in-process assistant keeps paths). |
| 20 | Tool descriptions and `docs/mcp.md` say the second language travels as a reader layer; rendering it into the pages is left in `tasks/two-languages.md`. |
| 21 | `assembleQueued` counts M4B assembly only. |
| 24 | `get_book` chapters carry `wordTiming`; `prepare_bilingual` and `export_book` answer with `warnings` naming chapters whose recording has no word times, or links missing. |
| 26 | Export refusals separate "no translation" from "not paired"; the MCP layer names chapter ids and the tool that fixes each. |
| 25 | Not changed — a pipeline semantics change, filed as `tasks/keep-audio-until-renarration-lands.md`. |
| 4, 15, 16, 23 | 4 dropped (moot with 3). 15 partly: summaries count instead of listing. 16 fixed on this book by hand. 23: plural fixed. |

Observations from round two:

- `wait_for_book timeoutSeconds: 600` was cut off by Claude Code's own request timeout ("The operation timed out"), so
  the description's advice to keep the 50 s default holds for this client.
- A client holds the tool schemas it read at connect time; new parameters are accepted by the server
  (the client does not validate), but an agent only learns about them after reconnecting.
- `get_book` showed Letter 3 already had word times while 12 chapters did not, which is exactly the
  question "which chapters do I re-narrate" — answered in one call where round one needed a file dig.

### What the whole-book run found, and what came of it

27. **The link worker stopped at the first incomplete batch — fixed.** `workers/prepare-bilingual.ts`
    threw on a batch whose answer named a token outside its sentence, so every later batch in the
    chapter went unrequested. A retry rebuilds batches from the unlinked groups, puts the group the
    model always gets wrong first, and stops at the same place: Chapter 4 sat at 23 of 85 groups
    linked through three paid retries, while the error read "Saved 4/5 sentence groups" as if one
    group were missing. An invalid answer now fails its batch only; the run goes on and fails at the
    end naming each incomplete batch. A provider error still ends the run. Regression test:
    "links the batches after an invalid one instead of stopping there". After the fix: 1,418 of
    1,422 matched groups linked.
28. **Some groups fail deterministically — open.** p16 and p130 were refused the same way three
    times ("Token 438 is not in the target sentence"). `parseWordLinks` drops the whole group when
    one link names a bad token. Dropping only that link would keep the rest, at the cost of trusting
    an answer that already mis-indexed once. That is a judgement for the feature's owner, not a fix.
29. **`prepare_bilingual` warned "no original recording" for chapters still narrating — fixed.**
    Pairing and linking need no recording; the warning now belongs to the export alone.
30. **A `bilingual` timeout said nothing of progress — fixed.** It carries the readiness counts and
    `inProgress`, one line per running preparation read from its job row: "Chapter 4 (links): 3/8
    batches".
31. **No way to price narration without starting it — fixed.** The exact Cartesia figure took 14
    `get_chapter` calls. `synthesize_book dryRun: true` now answers with the estimate, queues nothing
    and leaves the lane's voice alone.
32. **`/download/document/:id` sent no filename — fixed.** `curl -OJ` saved the EPUB as its bare id.
    It now sends `Content-Disposition: inline` with the file's name (inline keeps a PDF opening in the tab).
33. **No wait stage for translation — fixed.** `wait_for_book until:"translation"`, with `language`
    for one version; a failed chapter ends the wait with the version's error.
34. **`until:"audio"` without `language` reported any lane's old failure — fixed.** Variants carry
    `failedAt` / `audioFailedAt`, every failure message names its time, and without `language` only
    a failure from the last hour fails the wait; an older one is named in `reason` on a satisfied
    wait. With `language` any failure of that version still counts.
35. **Stored errors from before the Cartesia fix stay raw.** The Letter 1 lane still shows the JSON
    body; only new failures get the readable message.
36. **Spend was invisible (finding 11) — partly fixed.** `get_book`'s `bilingual` lanes and a
    satisfied `bilingual` wait carry `linkSpend`: batches, input and output tokens (failed batches
    included, since they were billed) and the models used. Not in money: the price would come from
    the models.dev catalog, which is often not cached, and a guessed price is worse than none.

### Round-two outcome

- English: all 14 chapters now carry word times (12 re-narrated with `kokoro:af_heart`, about 10 min
  locally; Letters 1 and 3 already had them).
- Bulgarian: the whole book translated (13 chapters in about 4 minutes), 170,484 characters.
- Pairs: 1,434 groups, 1,422 matched. Links: 1,418 groups, 26,953 word links.
- Export: document `4a36991d-21fc-4360-8450-7a346de3b541`, 87.8 MB, fetched through its
  `downloadUrl` to
  `~/Downloads/Frankenstein_or_The_Modern_Prometheus_bilingual_en-bulgarian_audio-original_pages_20260930_013353.epub`.
- Cartesia for the Bulgarian narration: about 170K credits. Pro (100K/month) covers Letters 1–4
  and Chapters 1–5; the whole book needs two months of Pro or one of Startup (1.25M).
- Checks: lint and typecheck green; the touched test files green. Full-suite runs fail on
  different files each time, all on 5–10 s timeouts under load, and pass alone — pre-existing.
