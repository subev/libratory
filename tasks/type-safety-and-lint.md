# Task: making the cheap signals sharp

The premise, in one line: **types, lint and tests are fast, deterministic and cheap, and every hour
spent making them louder is an hour of review and debugging you never have to spend.** The bug that
started this — a `useEffect` whose dependency array contained an inline arrow, producing a render
loop, React #185 and a white page — is caught by a lint rule that now exists in this repo and was
not enabled when it was written.

## End goal

`pnpm lint`, `pnpm typecheck` and `pnpm test` are all green, all enforced in CI, and sharp enough
that the classes of bug found on 2026-08-28 cannot be reintroduced silently.

## Where it stands (2026-08-28, commit 26bce74)

Done:

- TypeScript **7.0.2** (the Go port) across the workspace. server and web typecheck clean on it.
- Four strict flags on in `tsconfig.base.json`: `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`. Cost ten fixes, one of which was a real bug
  (a completion message that claimed success when every chapter had been suspended).
- **oxlint 1.80** installed and configured (`.oxlintrc.json`), `pnpm lint` / `pnpm lint:fix`.
  0.93s over 45k lines.
- `pnpm typecheck` added; `packages/desktop` has a `build` script at last, so `pnpm -r build`
  stops skipping it.

Not done — this is the work:

| # | What | Size | Touches |
| --- | --- | --- | --- |
| 1 | oxlint errors | ~~42~~ **done** | 51 warnings remain, deliberately |
| 2 | `noUncheckedIndexedAccess` — server | ~~558~~ **done** | flag lives in `packages/server/tsconfig.json` for now |
| 3 | `noUncheckedIndexedAccess` — web | **255 — next** | `packages/web/src`; move the flag to `tsconfig.base.json` when it lands |
| 4 | desktop `checkJs` | ~~29~~ **done** | |
| 5 | CI enforcement | ~~—~~ **done** | `pnpm lint` runs first in `test.yml`, before the build |

## Order, and why

Web lint (1) and web `noUncheckedIndexedAccess` (3) rewrite the same files, so they cannot run at
the same time. Everything else is disjoint by directory.

- **Wave 1, parallel:** web lint · server `noUncheckedIndexedAccess` + the one server lint error ·
  desktop `checkJs` · e2e and scripts lint
- **Wave 2:** web `noUncheckedIndexedAccess` — only after web lint has landed
- **Wave 3:** CI enforcement — only once everything above is green, or it lands red

## The pieces

### 1. oxlint errors (42)

`pnpm lint`. Fifty of the ninety-three findings are React effect and dependency rules —
`exhaustive-deps`, `set-state-in-effect`, `exhaustive-effect-dependencies` — which is the family
that produced the ModelPicker loop. **These are the point of the exercise; do not silence them.**

Worst files: `pages/Reader.tsx` (7), `components/ChapterModal.tsx` (6), `pages/BookDetail.tsx` (5).

A dependency added to an effect can change behaviour — an effect that ran once may now run on every
render. Each fix needs the effect read, not just the array filled in. Where an effect genuinely
should run once, say so in a comment rather than suppressing the rule silently.

### 2 & 3. `noUncheckedIndexedAccess` (813)

The single most valuable flag not in `strict`: `arr[0]` on a `string[]` is `string | undefined`, not
`string`. Turn it on in `tsconfig.base.json`.

Most fixes are mechanical (a guard, a `?? fallback`, destructuring with a default). Some are real —
an index access that genuinely can be out of bounds. Do not reach for `!` to make the number go
down; that is the flag switched off one site at a time.

Worth doing per-directory rather than in one commit.

### 4. desktop `checkJs` (29)

Flip `checkJs: true` in `packages/desktop/tsconfig.json` to reproduce.

All of them are one shape: `let server = null` and friends at module scope, dereferenced without a
guard. `HOME` is already fixed this way — typed `string`, initialised `""`, which is falsy exactly
as `null` was, so the `HOME || …` guards around it still behave identically. TypeScript 7 finds
these; 5.7 did not.

Two of today's shipped bugs lived in this file and neither was a type error, so treat this as
raising the floor rather than as bug-hunting.

### 5. CI enforcement

Done. `pnpm lint` runs first in `test.yml` — ahead of the build, because at under a second for 45k
lines it should fail fast rather than after two suites. It went in only once the 42 errors were
cleared: wiring it up red would have taught everyone to ignore it.

## Deliberately deferred

- **Type-aware linting** (`oxlint --type-aware`, needs `oxlint-tsgolint`). Now that the repo is on
  TypeScript 7 the requirement is met, and it brings 59 of typescript-eslint's 61 type-aware rules,
  including `switch-exhaustiveness-check` — which is what makes the status unions
  (`"pending" | "extracting" | …`, already declared through Drizzle's `enum`) actually enforce
  their cases at every use site. **This is the highest-value item after the list above.**
- The noisy rules turned off in `.oxlintrc.json`: `no-await-in-loop` (214 hits, and the sequential
  awaits here are deliberate), `no-shadow`, two unicorn style rules. Revisit only if they ever
  catch something real.

## Rules for anyone picking this up

1. **Never silence a rule to make a number go down.** A suppression needs a reason next to it, in
   the code. See `feedback-review-before-it-is-buried` in memory.
2. **Keep the three checks green between commits** — `pnpm lint`, `pnpm typecheck`, `pnpm test`.
   Landing a wave with one of them red loses the signal for everyone after you.
3. **One concern per commit.** A lint fix and a type fix in the same commit cannot be bisected apart
   when something regresses.
