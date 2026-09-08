# Security maintenance

## September 2026 baseline

The JavaScript audit initially reported 75 findings (43 high, 29 moderate, 3 low). Dependency
updates and targeted transitive overrides reduced this to zero. Root `package.json` records
the overrides; remove them as upstream packages adopt patched dependencies.

The document renderer is also installed independently by the desktop app. Its exact CLI version
and overrides live in `packages/server/src/lib/vivliostyle-package.json`; tests check agreement
with the checkout. Update both manifests together. The override of UUID to 14 requires the
modern Node/Bun runtime already required by the CLI (Node >=22.12); press-ready only calls v4.
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
