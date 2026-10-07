// The review gate. Every commit that reaches main must have been reviewed locally — main is
// released to everyone automatically (deploy.yml), so it is the last place anything is looked at.
// A review is recorded as a git note under refs/notes/review on the exact commit reviewed (the
// branch tip), and covers that commit and its ancestors back to where the branch left main. A
// commit added after the review is not covered, so it needs one of its own. Git notes are not
// copied across a rebase or amend unless notes.rewriteRef says so — leave it unset, because a
// rewritten commit is not the one that was reviewed.
//
//   node scripts/review.mjs stamp --level high --summary "2 findings fixed"
//                                       record a review of HEAD (after /code-review)
//   node scripts/review.mjs check <base> <tip>
//                                       exit 1 naming every commit in base..tip no review covers
//   node scripts/review.mjs pre-push <remote>
//                                       the hook: check what a push to main would add, then push
//                                       the notes along so deploy.yml can see them
//
// It proves a review was recorded for this code, not that the review was good: an honest-mistake
// guard. Stamping by hand is the deliberate override.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NOTES = "refs/notes/review";
const ZERO = /^0+$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const lines = (s) => (s ? s.split("\n").filter(Boolean) : []);

function stamp(args) {
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1] ?? null;
  };
  if (tryGit("status", "--porcelain")) {
    console.error("  Uncommitted changes — a stamp covers commits, so commit what was reviewed first.");
    process.exit(1);
  }
  const head = git("rev-parse", "HEAD");
  const note = [
    `Reviewed: ${opt("level") ?? "unspecified"}`,
    `Outcome: ${opt("summary") ?? "no summary given"}`,
    `By: ${tryGit("config", "user.name") ?? "unknown"}`,
    `At: ${new Date().toISOString()}`,
  ].join("\n");
  git("notes", `--ref=${NOTES}`, "add", "-f", "-m", note, head);
  console.log(`  Stamped ${head.slice(0, 10)} (${git("log", "-1", "--format=%s", head)})\n${note.replace(/^/gm, "    ")}`);
}

// Version-bump commits from before releases were tag-only; nothing reviewable in them.
const exempt = (sha) => /^Release \d/.test(git("log", "-1", "--format=%s", sha));

/** Commits in base..tip that no stamped commit in the range covers, merges excluded. */
function uncovered(base, tip) {
  const range = base ? `${base}..${tip}` : tip;
  const stamped = new Set(lines(tryGit("notes", `--ref=${NOTES}`, "list")).map((l) => l.split(" ")[1]));
  const covered = new Set();
  for (const sha of lines(git("rev-list", range))) {
    if (!stamped.has(sha)) continue;
    for (const c of lines(git("rev-list", base ? `${base}..${sha}` : sha))) covered.add(c);
  }
  return lines(git("rev-list", "--no-merges", range)).filter((sha) => !covered.has(sha) && !exempt(sha));
}

function check(base, tip) {
  const missing = uncovered(base, tip);
  if (!missing.length) {
    console.log(`  Every commit in ${base ? `${base.slice(0, 10)}..` : ""}${tip.slice(0, 10)} is covered by a review.`);
    return true;
  }
  console.error(`  ${missing.length} commit(s) not covered by a review:`);
  for (const sha of missing) console.error(`    ${git("log", "-1", "--format=%h %s", sha)}`);
  console.error("  Review the branch (/code-review), then: node scripts/review.mjs stamp --level <level> --summary \"…\"");
  return false;
}

// git feeds the hook "<local ref> <local sha> <remote ref> <remote sha>" per ref being pushed
function prePush(remote) {
  let ok = true;
  for (const line of lines(readFileSync(0, "utf8"))) {
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    if (remoteRef !== "refs/heads/main" || !localSha || ZERO.test(localSha)) continue;
    const base = remoteSha && !ZERO.test(remoteSha) ? remoteSha : null;
    if (base && !tryGit("cat-file", "-e", `${base}^{commit}`)) {
      console.error(`  ${remote}/main is at ${base.slice(0, 10)}, which this clone does not have — fetch first.`);
      ok = false;
      continue;
    }
    console.log(`  Push to main: checking ${base ? `${base.slice(0, 10)}..` : ""}${localSha.slice(0, 10)}`);
    if (!check(base, localSha)) ok = false;
  }
  if (!ok) {
    console.error("  Push refused. (git push --no-verify skips this; deploy.yml checks again and will not release it.)");
    process.exit(1);
  }
  // Along with every push, so a branch merged on GitHub carries its stamp to deploy.yml too
  if (tryGit("rev-parse", "--verify", "-q", NOTES)) {
    try {
      execFileSync("git", ["push", "--no-verify", "--quiet", remote, `${NOTES}:${NOTES}`], { stdio: "inherit" });
    } catch {
      console.error(`  Could not push ${NOTES}; deploy.yml will not see the reviews until it is pushed.`);
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "stamp") stamp(rest);
else if (command === "check") {
  const [base, tip = "HEAD"] = rest;
  if (!check(base ?? null, git("rev-parse", tip))) process.exit(1);
} else if (command === "pre-push") prePush(rest[0] ?? "origin");
else {
  console.error("  usage: review.mjs stamp --level <level> --summary <text> | check <base> [tip] | pre-push <remote>");
  process.exit(2);
}
