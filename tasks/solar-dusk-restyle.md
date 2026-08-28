# Task: Solar Dusk — one visual identity across site, icons and app

## Why

Three surfaces, three looks. The marketing site is a warm dark world (ember `#e2601f` on charcoal
`#16140f`, serif). The app icons already use the same brand pair (tangerine `#e2601f`, ink
`#2a1408`, page `#fdf1e4`). The app itself is stock Tailwind zinc + blue — it looks like a
different product wearing someone else's icon.

Target: [Solar Dusk](https://tweakcn.com/) — its warm oranges on warm charcoal are the same family
the site and the icons already live in.

## End goal

Every colour in the app comes from a token, both themes read correctly, and the app is
recognisably the same product as `~/repos/libratory-site` and its own icon.

## Two deliberate deviations from the tweakcn theme

1. **Its fonts are not adopted.** Solar Dusk ships Oxanium / Merriweather / Fira Code. Oxanium is a
   squarish display face that fights the site's Fraunces and is poor at UI density. The site's own
   faces are used instead — that is what "closer to the marketing site" actually means.
2. **Accent is the brand hex, not the theme's.** Solar Dusk's primary is
   `oklch(0.5553 0.1455 48.9975)`; the icon is `#e2601f`. The icon wins — app, icon and site
   should be the same orange, exactly.

## Type system: machinery in sans, library in serif

The subject is a reading app, so the split carries meaning rather than decorating.

| Role | Face | Where |
| --- | --- | --- |
| UI chrome | system sans stack | buttons, tables, labels, modals — everything you operate |
| Display | Fraunces (site's) | page and modal headings, the wordmark |
| Reading | Source Serif 4 (site's) | chapter text, reader, transcript — everything you read |
| Data | mono stack | logs, timings, sizes, percentages |

Fonts are copied from `~/repos/libratory-site/public/fonts` (all OFL). Self-hosted, never a CDN —
the desktop app runs offline.

## Phase 1 — the system (do this alone, first, and completely)

Nothing else can start until the vocabulary exists, or every agent invents its own name for
"the orange one".

- [ ] Bump Tailwind 4.1 → 4.3.3 in `packages/web` (and the site, so they cannot drift)
- [ ] `styles.css`: rewrite every existing token to Solar Dusk / site values, light **and** dark
- [ ] Add the tokens the 512 hardcoded utilities need somewhere to land:
      `--accent`, `--accent-hover`, `--accent-text`, `--accent-subtle`, `--focus-ring`,
      `--danger`, `--danger-bg`, `--danger-text`, `--success`, `--warning`
- [ ] `@theme` block so components can write `bg-accent` / `text-ink` as real utilities
- [ ] Copy the three woff2 files + `@font-face` + font stacks
- [ ] Dark theme grounds on the site's own `#16140f` / `#1e1b14` — the strongest continuity signal

## Phase 2 — the sweep (agents, parallel, partitioned by file)

512 hardcoded palette utilities across ~35 files (`bg-blue-600`, `text-red-600`, `bg-zinc-100`…).
Partitioned so no two agents touch one file:

| Agent | Files | Hits |
| --- | --- | --- |
| A | `pages/BookDetail.tsx` | 76 |
| B | `components/ChapterTable.tsx`, `components/ChapterModal.tsx` | 103 |
| C | `components/BookList.tsx`, `components/LogDock.tsx`, `components/BookFilesSection.tsx` | 91 |
| D | the modals — Digest, Structure, Settings, Variant, Extract, ChapterAi, HnDigest, FolderPicker | ~90 |
| E | `pages/Reader*.tsx`, `components/reader/*`, `components/voice-picker/*` | ~70 |
| F | everything remaining under `components/` | ~80 |

**Rules for every agent:**
1. Use only the tokens Phase 1 defines. Needing a new one means stopping and saying so — a
   one-off hex is how a token system dies.
2. Semantic mapping, not mechanical: `bg-blue-600` on a primary button is `--accent`; the same
   class on an "in progress" chip is a status colour. Read what it means before replacing it.
3. Do not restructure layout, spacing or components. Colour only.
4. `pnpm lint && pnpm typecheck` green before reporting.

## Phase 3 — verification (me)

- [ ] lint, typecheck, `pnpm test`, `pnpm e2e:smoke`
- [ ] Screenshots of every major surface in **both** themes — a token that only works in one is the
      classic failure and does not show up in any test
- [ ] `grep` for survivors: any `-(zinc|blue|gray|slate)-[0-9]` left in `packages/web/src`
- [ ] Kill the dev server afterwards

## Open question, deliberately not decided alone

The four pipeline states (extracting, synthesizing, normalizing, assembling) currently use four
unrelated hues — yellow, blue, purple, indigo. In a warm palette they all fight the accent, and
four arbitrary hues for four *sequential* stages is decoration rather than information. A heat ramp
(brass → ember, hotter the further along) would encode the progression. That is a UX change, not a
palette change, so it is proposed rather than done.
