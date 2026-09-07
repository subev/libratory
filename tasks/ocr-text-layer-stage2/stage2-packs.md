# Stage 2 / B — Tesseract language packs

Branch `feat/ocr-language-packs`. Database name `libratory_packs`. Ports `PORT=3064`, `WEB_PORT=3063`.
You own: `scripts/tessdata-manifest.mjs` and the generated manifest, `lib/tessdata.ts`, `lib/tessdata-manifest.*`,
the `ocrLanguages` tRPC router (+ one registration line in `router.ts`), the "OCR language packs" section in
`SettingsModal.tsx`, `packages/web/src/components/OcrLanguagePackControl.tsx`, and edits inside
`lib/ocr-tesseract.ts` / `lib/tesseract-languages.ts` that the managed directory requires. You do NOT touch
`ExtractModal.tsx`, `UploadZone.tsx`, `BookFilesSection.tsx`, `styles.css`.

## Verified facts (do not re-derive)

- `tesseract-ocr/tessdata_best` tag `4.1.0` = commit `e2aad9b983032bb1beff9133104a67cdbb87ca4d`. The GitHub tree API
  (`gh api "repos/tesseract-ocr/tessdata_best/git/trees/e2aad9b983032bb1beff9133104a67cdbb87ca4d?recursive=1"`) lists
  161 `.traineddata` blobs with exact byte sizes and git blob SHA-1s, e.g. `eng.traineddata 15400601
  176dc3220de7db34d3b3aecbfa42043a6038348b`, `bul.traineddata 8844613`, `chi_sim.traineddata 13077423`,
  `osd.traineddata 10562727`; `script/*.traineddata` are the script-level models (skip them; `script/Cyrillic` is 36 MB).
  Raw download URL: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/<commit>/<code>.traineddata`.
  A git blob SHA-1 is `sha1("blob " + byteLength + "\0" + bytes)` — that is the checksum, pinned by the tree, with
  no need to download 1.1 GB to build the manifest. The design review lists 13 sizes the mock got wrong: never
  hardcode a size anywhere; every number on screen comes from the manifest.
- `tesseract --list-langs` prints `List of available languages in "/opt/homebrew/share/tessdata/" (N):` then one code
  per line — the directory in that first line is the compiled-in default when `TESSDATA_PREFIX` is unset.
- Writing a searchable PDF needs `configs/pdf`, `tessconfigs/`, and `pdf.ttf` beside the `.traineddata` files in the
  ONE directory `TESSDATA_PREFIX` names (verified; failure is instant and silent). Stage 1 stages those from the app
  bundle into `HOME/tessdata` on the desktop; in a checkout `TESSDATA_PREFIX` is unset today.
- The model-bundle download pattern to mirror: `lib/model-bundles.ts` (`listModelBundles`, `bundleInstalled`,
  `startBundleDownload`, `whenBundleInstalled`), `routes/models.ts`, `<ModelBundleNotice>` +
  `useModelBundle` in the web. Read them; copy the shape (start + poll), not the Python.
- `packages/web/src/lib/format.ts` has `formatBytes` / `formatSize`; `SettingsModal` sections are `<h3>` blocks on
  the `panel` surface (AGENTS.md "Surfaces").

## Decisions

1. **Manifest, generated and committed.** `scripts/tessdata-manifest.mjs` reads the pinned tree and writes
   `packages/server/src/lib/tessdata-manifest.json`: `{ repo, commit, tag, languages: [{ code, name, bytes, sha1 }] }`
   for every top-level `<code>.traineddata` except `osd` (it is not a language) — 120-odd entries. `name` is the
   English name from a table inside the script (tesseract's documented list: "Chinese, Simplified" for `chi_sim`,
   "Chinese, Traditional" for `chi_tra`, "Serbian, Latin" for `srp_latn`, and so on; every code must have a name or
   the script fails). The pin (commit) lives in `scripts/pins.json` under a new `tessdata` key with a `_comment`,
   the way `bundledTools` is pinned. Re-running the script with the same pin is a no-op diff.
2. **One managed directory.** `lib/tessdata.ts` exports `tessdataDir()`: `env.TESSDATA_PREFIX` when set, else
   `DATA_DIR/tessdata`. On first use, if the directory lacks `configs/pdf` / `tessconfigs` / `pdf.ttf` / `eng` / `osd`,
   copy them from the compiled-in default directory (parsed from `tesseract --list-langs`), never deleting anything
   already there. Every tesseract subprocess in the repo then runs with `TESSDATA_PREFIX=tessdataDir()` — update
   stage 1's runner and `--list-langs` check to go through it. Downloaded packs land there, so shipped and downloaded
   packs are indistinguishable to Tesseract.
3. **Download = one file, atomic, checksummed.** `<code>.traineddata.part` streamed from the raw URL, blob SHA-1
   verified, renamed into place; any failure deletes the part file. In-memory progress (`bytes`, `total`) like
   `startBundleDownload`; a second start for the same code while one runs returns `started: false`. A network error
   is reported as such ("could not reach github.com") so the UI can say why an uninstalled pack cannot be fetched.
4. **tRPC `ocrLanguages`**: `list` → every manifest language `{ code, name, bytes, installed, download?: { bytes,
   total } | { error } }` (installed = file present in `tessdataDir()` with the manifest's byte size);
   `download({ code })`; `remove({ code })` — refuse `eng` (shipped; it is re-staged on next launch anyway).
   Zod-validate `code` against the manifest, never against a regex.
5. **Settings section "OCR language packs"** in `SettingsModal`: installed packs with size and Remove; an "Add
   language" `<select>` over the rest, sorted by name, each option `"<name> — <size>"` (check the longest,
   "Chinese, Traditional — …", fits), a Download button, inline progress, the offline reason on failure.
6. **`<OcrLanguagePackControl code onInstalled />`** — the inline control the Try One Page screen embeds (that
   agent imports it from `./OcrLanguagePackControl` by this exact name and props; if you change either, say so
   loudly in your report). Renders nothing when the pack is installed; otherwise one row: "<name>, <size>" + Download
   → progress → calls `onInstalled()` when the file is in place; on failure shows why (offline vs checksum). Uses
   `ocrLanguages.list` with a short poll while a download runs, like `useModelBundle`.
7. **Language table.** `lib/tesseract-languages.ts` (stage 1) maps ISO-639-1 → tessdata code; keep it the source
   of truth for the *app's* book languages and make its names come from the manifest so there is one spelling.

## Proof

- `lib/tessdata.test.ts`: staging into an empty dir copies the five things and leaves an existing stray file alone.
- `lib/tessdata-manifest.test.ts`: every entry has a name, bytes > 0, sha1 of 40 hex; `eng`, `bul`, `chi_sim` sizes
  match the verified numbers above.
- Download: a real download of the smallest pack in the manifest into a temp `tessdataDir()` (it is a few hundred
  KB), checksum verified, then `tesseract --list-langs` in that dir lists it. Then remove it.
- Route tests in the neighbours' shape for `list` / `remove` (`routes/*.test.ts`).
- Manual proof pasted in the report: in the running app on your ports, Settings → download Bulgarian → the pack
  appears installed with 8.8 MB, `tesseract --list-langs` with your `tessdataDir()` shows `bul`, and a one-page
  `tesseract … -l bul pdf` run from that directory succeeds (the configs/pdf.ttf staging is what that proves).
- Docs: AGENTS.md (tables, Key External Tools, the `TESSDATA_PREFIX` gotcha with the configs/pdf.ttf fact), README
  if it lists what is downloaded on demand.

## Addendum — the design is available, and it fixes the row's copy and the shared interfaces

Read `/private/tmp/claude-501/-Users-petur-repos-libratory/469feb73-d524-44b1-b533-8781c6dfd6a0/scratchpad/design-summary.md` §2d and §5 (the language pack row: four states — needs download, downloading,
offline, just installed — with exact copy, icons and tints) and, if you want the markup, the mock itself at
`/private/tmp/claude-501/-Users-petur-repos-libratory/469feb73-d524-44b1-b533-8781c6dfd6a0/scratchpad/OCR Try One Page.dc.html`. Build the row to that spec.

Rename decision 6's component: it is **`packages/web/src/components/OcrLanguagePackRow.tsx`** exporting
`OcrLanguagePackRow({ code, onInstalled }: { code: string; onInstalled: () => void })`. It renders the mock's row
(full width, appears/disappears entirely): "needs download" with `"<Name>, <size>."` and the mock's body sentence and
Download button; "downloading" with the progress bar and `"NN% of X MB"`; "offline" (muted, `IconWifiSlash` or the
nearest re-export you add, disabled button, the mock's copy); and the transient "installed" success state (`"<Name>
installed."` / `"Selected and ready — run the page now, without closing anything."`) that calls `onInstalled()` and
then disappears. It also carries the chip label the controls row shows (`"needs <lang>"` etc.) — export a small
`packChipLabel(...)` helper from the same module or from `packages/web/src/lib/ocr.ts` (stage 1 created that file).

The tRPC shape the Try One Page agent codes against — keep it exactly:
- `ocrLanguages.list` → `Array<{ code: string; name: string; bytes: number; installed: boolean;
  download: { received: number; total: number; error: string | null } | null }>`
- `ocrLanguages.download({ code })` → `{ started: boolean }`
- `ocrLanguages.remove({ code })` → `{ removed: boolean }`

The Try One Page branch carries a placeholder `routes/ocr-languages.ts` and `OcrLanguagePackRow.tsx` marked
`// Placeholder — replaced by feat/ocr-language-packs`; the orchestrator takes YOUR versions at merge, so do not
worry about them, but do keep the names above.

Also yours, because it is language data: stage 1 bundles Homebrew's `eng.traineddata` (4.1 MB, the fast model) into
the desktop tarball, while every downloaded pack is `tessdata_best`. Make `scripts/bundle-tools.py` fetch `eng` and
`osd` from the pinned `tessdata_best` commit (blob SHA-1 verified, using the same code path as the app's downloader
or a copy of the 20 lines) instead of copying Homebrew's, so shipped and downloaded packs are the same model family.
Do not rebuild or upload the tarball; report that it must be rebuilt.
