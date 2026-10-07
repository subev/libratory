#!/usr/bin/env node
// Cuts a release. Works out the version, tags main's head with it and pushes the tag — which is
// what starts the build. Nothing is committed: the build stamps the version into
// packages/desktop/package.json from the tag (release.yml), so main only ever changes through a
// reviewed merge (scripts/review.mjs) and the version on main is not the release's. It exists
// because a version worked out by hand is a version that is one digit wrong on a Friday.
//
//   node scripts/release.mjs            what would happen, and stop
//   node scripts/release.mjs --yes      do it
//
// Versions are v<YY>.<MMDD>.<n>: v26.826.0 is the first release on 26 August 2026, v26.826.1 the
// second that day. Three numeric parts because electron-updater compares with semver and rejects
// anything else; see packages/desktop/README.md for why a 4th part and a -2 suffix both fail.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  // The tag would name a commit main does not have; it gets there through a pull request
  const ahead = git("rev-list", "--count", "origin/main..HEAD");
  if (ahead !== "0") fail(`${ahead} commit(s) not on origin/main.`, "Merge them through a pull request first.");
  const tagged = git("tag", "--points-at", "HEAD", "--list", "v*");
  if (tagged) fail(`HEAD is already released as ${tagged.split("\n").join(", ")}.`, "Nothing new to release.");
}

function main() {
  preflight();
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const version = nextVersion(tags);
  const previous = git("describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD");

  console.log(`\n  version   ${version}`);
  console.log(`  tag       v${version} on ${git("log", "-1", "--format=%h %s", "HEAD")}`);
  console.log(`  since     ${previous}:`);
  for (const subject of git("log", "--no-merges", `${previous}..HEAD`, "--format=%s").split("\n").filter(Boolean)) {
    console.log(`            ${subject}`);
  }
  console.log(`  then      the Release workflow builds a DMG and opens a draft release`);

  if (!go) {
    console.log(`\n  Nothing done. Re-run with --yes to cut it.\n`);
    return;
  }

  git("tag", `v${version}`);
  git("push", "origin", `v${version}`);

  console.log(`\n  Pushed v${version} — a DRAFT. Nobody is offered it until it is published.`);
  console.log(`  Watch the build:  gh run watch`);
  console.log(`  Then publish it:  pnpm ship\n`);
}

main();
