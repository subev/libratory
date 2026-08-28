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

## Phase 2 — the sweep — DONE

Six agents, partitioned by file. **512 hardcoded palette utilities → 3**, and **~300 `dark:` variants → 0**
(the tokens switch themselves, so a `dark:` whose only job was a colour is dead weight).

The three survivors are `CueOverlay.tsx`'s debug rect outlines — sky / fuchsia / emerald behind the
`rects` and `layout` checkboxes. They need to be mutually distinguishable and no user ever sees them.

### What the sweep found that the palette had not accounted for

Three agents independently hit the same hole, which is why it was real and not one agent guessing:

- **`--on-*` vs `--*-text`.** `--danger-text` is text *in* red; there was nothing for text sitting *on*
  a red fill. That gap produced `bg-(--warning) text-white` at **2.53:1**. Added `--on-accent`,
  `--on-danger`, `--on-success`, `--on-warning` — brass and ember both take ink, as the icon does.
- **No hover partners.** Every agent correctly *dropped* `hover:bg-red-700` rather than fake it from a
  text token. Added `--danger-hover`, `--success-hover`, `--warning-hover`.
- **`--bg-hover` never existed** — not in the new file and not in the old one. Nine references across
  five files had been painting nothing. Pointed at `--bg-card-hover`.
- **`--bg-terminal-hover`**, because the log dock's bar is fixed and an alpha hover would composite the
  page behind it and flash cream in light mode.

### The categorical question, decided

Four systems used colour as a category. Only one of them was carrying information:

| System | Decision |
| --- | --- |
| Step labels 1·Input / 2·Work / 3·Output | **a ramp** — brass → ember → green. It is a sequence, so colour can encode it. |
| Book kinds (digest, api, reader) | neutral — the label already says which |
| Activity pills (translating, AI note, digesting) | one "busy" look — the label carries the difference |
| Action buttons (5 lanes, 5 hues) | one accent primary per lane, neutral outline for peers |

Notes left the colour system entirely: it is a section, not a pipeline step. Six filled colours in a
row was the actual design problem; the blue palette had only hidden it better.

## Phase 3 — verification — DONE

- 541 unit tests, `pnpm lint` 0 errors, typecheck clean, `pnpm -r build` clean
- e2e smoke 17/19 — the two `uc9` failures are environmental (the packaged app holds port 3034, so
  Vite proxies to *its* server, which reads `.models-missing` from another path). Same pair as
  earlier today; they pass when the port is free.
- Screenshots of library, book detail and chat in **both** themes. They caught one thing no test
  could: two accent-filled digest buttons side by side. HN digest is now the secondary it always was.
- Dev server shut down afterwards.
