# Security maintenance

## September 2026 baseline

The JavaScript audit initially reported 75 findings (43 high, 29 moderate, 3 low). Dependency
updates and targeted transitive overrides reduced this to zero. Root `package.json` records
the overrides; remove them as upstream packages adopt patched dependencies.

`patches/plist@3.1.0.patch` supplies the XML MIME type required by patched xmldom. Electron's
packaging and signing tools still use this CommonJS plist release; newer plist majors are ESM.
The desktop packaging test exercises the actual builder dependency. Remove the patch when
those tools adopt a compatible parser.

The document renderer is also installed independently by the desktop app. Its exact CLI version
and overrides live in `packages/server/src/lib/vivliostyle-package.json`; tests check agreement
with the checkout. Update both manifests together. The override of UUID to 14 requires the
modern Node/Bun runtime required by the CLI (its own floor is Node >=22.12; the repo now requires
>=22.22); press-ready only calls v4.
The old esbuild loader under drizzle-kit is kept on patched esbuild and checked by loading the
CLI and the project's TypeScript configuration.

The main Python lockfile initially reported 47 OSV records, including duplicate aliases. Pillow
12.3, PyTorch 2.13 and setuptools 84 reduced that to nine records in Transformers and Accelerate.
Pillow is an explicit override of Marker/Surya's <11 cap. Real offline Marker extraction, Surya
OCR and Kokoro synthesis were exercised with the patched packages; this is not a claim that
every model and GPU backend was exercised.

The remaining records are **deferred, not fixed**. Each has an exact package/version/ID, a reason,
and an expiry in `scripts/python-audit-exceptions.json`. CI prints them and fails for new
findings, changed versions, expired exceptions, adverse package statuses, or invalid reports.
[The ML migration task](../tasks/security-ml-upgrades.md) records the upstream blockers.

## September 9 dependency refresh

Reviewed npm versions, upstream migration notes, and the live GitHub Security tab. Updated
React Router 7.18.3 → 8.3.1, Vitest 4.1.11 → 5.0.0, Zod 3.25.76 → 4.5.4, and Graphile Worker
0.16.6 → 0.18.0. Also refreshed React/React DOM, tRPC (all three packages together), React Query,
AI SDK and its providers, Fastify CORS/multipart, Postgres.js, dotenv, PDF.js, Electron,
Playwright/PDFKit, oxlint, Defuddle and type definitions. Node types stay on the supported 22
line; Vite, TypeScript, Drizzle and Vivliostyle were already at their latest stable versions.

Compatibility decisions:

- [React Router 8](https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v800)
  requires Node >=22.22 and React >=19.2.7. The manifest, setup check and README now agree.
  This app uses BrowserRouter; the framework-mode middleware/loader changes do not apply.
- [Zod 4](https://zod.dev/v4/changelog) tightens UUID validation. Profile routes explicitly
  accept the existing seeded default ID as well as RFC UUIDs through a shared schema, preserving
  rename, the default-profile deletion guard, and HN builds after switching back to Default.
- [Vitest 5](https://github.com/vitest-dev/vitest/releases/tag/v5.0.0) works with the existing
  test configuration and Vite 8; no compatibility flags or disabled tests were needed.
- [Graphile 0.18](https://github.com/graphile/worker/releases/tag/v0.18.0) moves to ESM;
  0.17 also changes lock ownership to the worker pool. A disposable database upgrade from
  0.16.6 preserved and executed an already-queued job. A permanent real-worker test checks
  job-key deduplication, completed-job removal, and one-attempt failure retention. Stop old
  server/worker processes before starting the updated version; do not run mixed versions.
- [Multipart 10](https://github.com/fastify/fastify-multipart/releases/tag/v10.0.0) changes
  `saveRequestFiles` results, which this app does not use. Upload tests exercise our streaming
  path on 10.1.1.

Validation: lint (existing warnings remain), typechecking including e2e, production web build,
701 unit/integration tests, and all 28 browser tests against the compiled Bun server, including
real extraction, synthesis, audiobook assembly, read-along and PDF/EPUB export. The browser run
used a disposable library and settings file. Export passed on rerun after configuring its renderer
prerequisite and making the test target the chapter tray's button across the tab transition.
Electron 44.3.0, PDFKit fixture generation, and Drizzle CLI/config loading were also checked.

The refresh exposed a test-isolation bug: real Graphile calls could capture the checkout's
database URL even when `db.ts` was mocked. This applied the worker migrations to the local
database during the first test run. The setup now assigns each test file's database URL before
application modules load, and the note-to-chapter test verifies its index job exists there.

Security result: `pnpm audit` reports **zero vulnerabilities**. GitHub has **zero open code-scanning
and secret-scanning alerts**, with **five open Dependabot alerts**, all in the unchanged Python
stack (four Transformers, one Accelerate). Pocket TTS's separate audit is also clean. The main
Python audit still reports the same nine OSV
records covered by the existing expiring exceptions. The larger ML migration remains in
`tasks/security-ml-upgrades.md`; no alerts were dismissed and no exceptions were broadened.

## Keeping bot PRs manageable

Routine JavaScript updates run monthly in two groups (minor/patch and major), with at most two
open version PRs. Node type majors are ignored because types follow the minimum supported runtime.
Actions updates form one monthly group, capped at one open version PR. Test and Security workflows
cancel older runs for the same event/branch when a newer commit arrives; release builds are unaffected.

Python version PRs are disabled (`open-pull-requests-limit: 0`), while security update PRs,
Dependabot alerts and weekly audits remain enabled. The uv updater excludes `scripts/**` so the
pip updater owns Pocket's separate requirements. The September bot PRs demonstrated why ML
updates require manual review: uv applied the main NumPy 1 override to Pocket, and both updaters
generated CUDA dependencies for a CPU-only environment. Recompile Pocket with the command below
and run real model checks before changing ML pins. Even security PRs need this review.

## Running audits

```sh
pnpm audit
.uv/uv audit --locked --output-format json > /tmp/python-audit.json
# uv exits 1 when it finds vulnerabilities; inspect them through the reviewed exception gate:
node scripts/check-python-audit.mjs /tmp/python-audit.json
node --test scripts/check-python-audit.test.mjs
.uv/uv tool run pip-audit==2.10.1 --no-deps --disable-pip -r scripts/requirements-pocket.txt
```

`uv audit` examines the lockfile without installing the ML stack. The pinned uv version is
0.12.5 because the JSON format is experimental; update the gate and tests if the schema changes.
Pocket's full transitive requirements are compiled independently from the main project's
overrides, with the CPU PyTorch backend:

```sh
.uv/uv --no-config pip compile scripts/requirements-pocket.in --python-version 3.12 \
  --universal --torch-backend cpu -o scripts/requirements-pocket.txt
```

Never let the main project's NumPy 1 override reach Pocket, which needs NumPy 2. Linux Pocket
installation must retain `--torch-backend=cpu` so the `+cpu` pin resolves at the PyTorch index.

## GitHub and release controls

Dependabot alerts/security updates, private vulnerability reporting, and default CodeQL setup
are enabled on `subev/libratory`. Secret scanning and push protection are enabled. The checked-in
Security workflow adds weekly and PR audits and dependency review; Dependabot updates are
grouped and manually merged. CodeQL's default setup is managed in GitHub settings, not duplicated
in an Actions workflow. Local workflow and policy changes take effect after merging to `main`.

Actions are pinned to upstream commit SHAs. Tests and audit jobs have read-only tokens; the release
job needs contents write to publish drafts. Tag builds check out the tag and verify its version
against the package; manually dispatched releases still cut from `main`.

The first CodeQL scan reported 19 findings on the pre-fix main branch. Uploads now use generated
storage names, OCR scratch paths validate their components where constructed, and Marker reading
text uses a DOM parser instead of chained HTML substitutions. Expensive HTTP routes have per-IP,
per-route limits per minute: uploads 600, HN scripts 20, voice previews 120. Ordinary reading,
playback and polling routes are not rate-limited. Rejections return HTTP 429 with Retry-After;
there are no silent retries. GitHub must rescan the merged changes before alerts can close.

These checks complement the local-only deployment boundary in [SECURITY.md](../SECURITY.md).
They do not certify the app as safe to expose as an unauthenticated public server.
