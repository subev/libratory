#!/usr/bin/env node
// Cuts a release. Works out the version, commits it, tags it, pushes — which is what starts the
// build. Nothing here is clever; it exists because doing it by hand means editing a version in a
// file, and a version edited by hand is a version that is one digit wrong on a Friday.
//
//   node scripts/release.mjs            what would happen, and stop
//   node scripts/release.mjs --yes      do it
//
// Versions are v<YY>.<MMDD>.<n>: v26.826.0 is the first release on 26 August 2026, v26.826.1 the
// second that day. Three numeric parts because electron-updater compares with semver and rejects
// anything else; see packages/desktop/README.md for why a 4th part and a -2 suffix both fail.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(REPO, "packages/desktop/package.json");
const go = process.argv.includes("--yes");

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

function fail(message, fix) {
  console.error(`\n  ${message}`);
  if (fix) console.error(`  ${fix}`);
  process.exit(1);
}

// Today, as the release names it. Deliberately local time: the version is a label for a human,
// and a release cut at 11pm should carry the date the person cutting it would say out loud.
function today() {
  const now = new Date();
  return { yy: now.getFullYear() % 100, mmdd: (now.getMonth() + 1) * 100 + now.getDate() };
}

function nextVersion(tags) {
  const { yy, mmdd } = today();
  const prefix = `v${yy}.${mmdd}.`;
  const used = tags
    .filter((t) => t.startsWith(prefix))
    .map((t) => Number(t.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  return `${yy}.${mmdd}.${used.length ? Math.max(...used) + 1 : 0}`;
}

// Every one of these has a way of being discovered after the tag is pushed, which is the one point
// where undoing it means deleting a tag other people may already have fetched.
function preflight() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") fail(`On branch ${branch}, not main.`, "git switch main");
  if (git("status", "--porcelain")) fail("Uncommitted changes.", "Commit or stash them first.");

  git("fetch", "origin", "main", "--tags", "--quiet");
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  if (behind !== "0") fail(`${behind} commit(s) on origin/main that you do not have.`, "git pull --rebase");
}

function main() {
  preflight();
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const version = nextVersion(tags);
  const ahead = git("rev-list", "--count", "origin/main..HEAD");

  console.log(`\n  version   ${version}`);
  console.log(`  tag       v${version}`);
  console.log(`  pushing   ${ahead} commit(s) to origin/main`);
  for (const subject of git("log", "origin/main..HEAD", "--format=%s").split("\n").filter(Boolean)) {
    console.log(`            ${subject}`);
  }
  console.log(`  then      the Release workflow builds a DMG and opens a draft release`);

  if (!go) {
    console.log(`\n  Nothing done. Re-run with --yes to cut it.\n`);
    return;
  }

  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const alreadyRight = pkg.version === version;
  pkg.version = version;
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);

  // The version can already be what we want — a release cut on the same day as the last edit, or a
  // retry after a push that failed. Committing nothing is an error to git, not to us.
  if (!alreadyRight) {
    git("add", PKG);
    git("commit", "-m", `Release ${version}`);
  }
  git("tag", `v${version}`);
  git("push", "origin", "main", `v${version}`);

  console.log(`\n  Pushed v${version} — a DRAFT. Nobody is offered it until it is published.`);
  console.log(`  Watch the build:  gh run watch`);
  console.log(`  Then publish it:  pnpm ship\n`);
}

main();
