import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "review.mjs");
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// A repo with main's head as the push base and one commit on top of it
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "review-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(dir, "f"), "x");
  git("add", "f");
  git("commit", "-q", "-m", "change");
  return { dir, base, tip: git("rev-parse", "HEAD") };
}

const review = (dir, args, input) => spawnSync("node", [script, ...args], { cwd: dir, input, encoding: "utf8" });
const pushLine = (tip, base) => `refs/heads/x ${tip} refs/heads/main ${base}\n`;

test("a stamped push onto a main this clone has goes through", () => {
  const { dir, base, tip } = repo();
  assert.equal(review(dir, ["stamp", "--level", "low", "--summary", "test"]).status, 0);
  const run = review(dir, ["pre-push", "nowhere"], pushLine(tip, base));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /covered by a review/);
});

test("an unstamped push to main is refused", () => {
  const { dir, base, tip } = repo();
  const run = review(dir, ["pre-push", "nowhere"], pushLine(tip, base));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not covered by a review/);
});

test("a push onto a main this clone has never fetched is refused", () => {
  const { dir, tip } = repo();
  assert.equal(review(dir, ["stamp", "--level", "low", "--summary", "test"]).status, 0);
  const run = review(dir, ["pre-push", "nowhere"], pushLine(tip, "1".repeat(40)));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /fetch first/);
});
