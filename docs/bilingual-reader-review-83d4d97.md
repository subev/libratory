# Review of 83d4d97 — fix(bilingual): preserve queued work and convert legacy recordings

Reviewed 2026-09-28, inline (no agents), against the commit diff and the code it touches.
No tests, lint or browser checks were re-run for this review.

## Verdict

The job-state change is sound. The conversion's publish path is careful: it takes a row lock,
re-checks the recordings, publishes both paths together and cleans up on failure. Four findings
below, none blocking. Finding 1 is the only one a user can hit through ordinary use.

## Findings

### 1. Conversion is refused whenever the original chapter is not `done`, even if only the translation is MP3 — medium

`packages/server/src/lib/bilingual-audio.ts:18-21`

```ts
if (before.chapter.status !== "done" || before.variant.audioStatus === "pending" || ...) {
  throw new Error("Finish or stop narration before converting recordings");
}
```

The gate checks the chapter's own status on every call, including when the source side has
nothing to convert. `legacyAudio` in `routes/bilingual.ts:31` is true when *either* side is MP3,
so the button still appears.

**Repro:** a chapter whose original was never narrated (`status: "suspended"`, `audioPath: null`)
with a translation narrated as MP3 before the M4A switch (`audioStatus: "done"`, `.mp3`). The panel
shows "Convert recordings for accurate seeking" as enabled. Pressing it returns "Finish or stop
narration before converting recordings", which is wrong: nothing is being narrated. The same
happens for a chapter left `failed` by a later re-synthesis attempt.

**Suggested fix:** check `chapter.status` only when the source side will be converted. Use
"narration in flight" (`pending`/`normalizing`/`synthesizing`) as the refusal condition instead of
"not done". The transaction's equality re-check already guards against races.

**Test gap:** no test converts only one side. None covers the refusal path either.

### 2. The retained MP3 and each conversion copy become files that nothing can reach or remove — low

`lib/bilingual-audio.ts:53-56`, `lib/chapter-artifacts.ts:11-15`, `workers/synthesize.ts:158-161`

After publishing, no row refers to the MP3 original or its `.sync.json`, so the app cannot serve,
restore or delete them. Two later actions also leave the `.seek-<uuid>.m4a` behind:

- **Delete audio** (`removeChapterArtifacts`) unlinks the current `audioPath`, which is now the
  seek copy. The MP3 and both sync maps stay on disk.
- **Re-synthesis** writes `chNNN.m4a` and repoints `audioPath` without unlinking the previous
  path. Before this commit, re-synthesis overwrote the same file in place. Now the seek copy and its
  map are orphaned for good.

Deleting the book still removes the output directory, so the leak is limited to each book. Chapter
MP3s run tens of MB each, though, and `cleanup:chunks` and the disk-usage breakdown do not count
this kind of leftover.

**Options:** (a) delete the MP3 and its map after a successful publish, since the M4A was
transcoded from it and keeping it gives no restore path; or (b) keep it but record it so
delete-audio and re-synthesis remove it too; or (c) have re-synthesis unlink the previous
`audioPath` when it differs from the new one. Option (c) is worth doing either way.

### 3. The Convert button is enabled in states the server refuses — low

`packages/web/src/components/BilingualPreparation.tsx:64-68`

The button is disabled only on `busy`, which describes the bilingual jobs, or while the mutation
is pending. It stays enabled while a chapter or translation is being narrated, and in the case from
finding 1. The project's button rule says to disable an action whose target exists but cannot run,
and to give a title saying why. The status query could return a `convertBlocked: string | null`
reason from the same checks the mutation uses.

A related note: `busy` disables the button even though bilingual preparation never reads audio.
That is harmless, but the server does not enforce it, so the UI and server disagree about whether
the two can run together.

### 4. Whole-file SHA-256 of both recordings runs inside the `FOR UPDATE` transaction — low

`lib/bilingual-audio.ts:38-52`

The transaction locks the chapter and variant rows, then hashes both originals, both source maps
and both copied maps. For a long chapter (a 60 MB MP3 or more) this holds the lock for as long as
the hashing takes. A synthesis progress write or a `variants` update on that row waits during that
time. It does not cause wrong results, only avoidable contention. `bilingual-document.ts` already
detects changes with a `stat` (mtime + size) comparison. The same comparison inside the lock, with
the full hash taken just before it, would keep the lock short.

## Checked and not a problem

- **Removing the 15-minute stale guard.** The worker calls `failPreparation` before rethrowing
  (`workers/prepare-bilingual.ts:70-74`). The boot sweep deletes dead or exhausted graphile rows
  *before* it fails orphaned preparations (`workers/sweep.ts:22-28`, `111-122`), so the `NOT EXISTS`
  check does not see an exhausted row. The remaining gaps are a job cleared by hand
  (`pnpm jobs:clear`) while the server is running, and a failure in the lines before the worker's
  `try` (`prepare-bilingual.ts:15-16`). Both stay "busy" until the next restart, and Stop still
  works in that state, as the new test shows.
- **Concurrent conversions.** Each run writes its own `.seek-<uuid>` copy. The second run fails the
  `audioPath` equality check under the lock and removes its copies.
- **The `.seek-<uuid>.m4a` naming** does not break any consumer. Download names use only the
  extension (`main.ts:180`, `197`). EPUB and p2af exports read `extname` (`readaloud-epub.ts:256`,
  `p2af.ts:162`).
- **Trim equality** in the lock matches `bilingualContext`, which also trims (`bilingual-store.ts:15`).
- **`audio-seek.mjs`** subtracts one ScriptProcessor block (2048 / 8000 = 256 ms), the latency the
  response doc describes. The three-seconds-before-the-end guard keeps `end >= start`.

## Verification gaps

- The integration tests were not re-run and no browser check was run. The review was done from
  reading the code.
- Finding 1 was traced by reading the code, not reproduced against a database.
- The claim that the MP3-to-M4A transcode keeps the sync-map timeline (encoder priming, edit list)
  rests on the commit's acoustic measurement (errors under 2 ms at four points). This review did not
  measure it again.
