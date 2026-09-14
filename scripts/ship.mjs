#!/usr/bin/env node
// Publishes the draft release that `pnpm release` left behind. The two halves are deliberately
// separate — cutting a release is safe and reversible, making it public is neither, because
// electron-updater starts offering it to everyone the moment it stops being a draft.
//
//   node scripts/ship.mjs               the newest draft, then ask
//   node scripts/ship.mjs v26.828.4     that one
//   node scripts/ship.mjs --yes         do not ask
//
// It refuses to publish a build that is still running, that failed, or that is missing an
// artefact — all three produce a draft that looks perfectly normal in the GitHub UI.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { renderCask, TAP, ZIP } from "./cask.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const go = args.includes("--yes");
const wanted = args.find((a) => a.startsWith("v"));

const run = (cmd, ...a) => execFileSync(cmd, a, { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const gh = (...a) => run("gh", ...a);
const git = (...a) => run("git", ...a);

function fail(message, fix) {
  console.error(`\n  ${message}`);
  if (fix) console.error(`  ${fix}`);
  process.exit(1);
}

const size = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${Math.round(bytes / 1e6)} MB`);

// v26.828.3 → [26, 828, 3], so releases sort the way their numbers read rather than as strings.
const parts = (tag) => tag.replace(/^v/, "").split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function main() {
  const releases = JSON.parse(gh("release", "list", "--limit", "30", "--json", "tagName,isDraft"));
  // tools-* and media are releases too, and only v<version> tags carry a build worth checking.
  const drafts = releases.filter((r) => r.isDraft && /^v\d/.test(r.tagName))
    .map((r) => r.tagName).sort((a, b) => (newer(a, b) ? -1 : 1));

  if (!drafts.length) fail("No draft release to publish.", "pnpm release --yes cuts one.");
  const tag = wanted ?? drafts[0];
  if (!drafts.includes(tag)) {
    fail(`${tag} is not a draft.`, `Drafts waiting: ${drafts.join(", ")}`);
  }
  if (!wanted && drafts.length > 1) {
    console.log(`\n  NOTE  ${drafts.length} drafts waiting: ${drafts.join(", ")} — taking the newest.`);
  }

  const build = JSON.parse(gh("run", "list", "--workflow", "release.yml", "--branch", tag, "--limit", "1",
    "--json", "status,conclusion,databaseId"))[0];
  if (!build) fail(`No build found for ${tag}.`, "The tag may not have started a workflow run.");
  if (build.status !== "completed") fail(`The build for ${tag} is still ${build.status}.`, "Wait for it to finish.");
  if (build.conclusion !== "success") fail(`The build for ${tag} ended as ${build.conclusion}.`, `gh run view ${build.databaseId} --log-failed`);

  const release = JSON.parse(gh("release", "view", tag, "--json", "body,assets"));
  const names = new Set(release.assets.map((a) => a.name));
  const missing = ["Libratory-arm64.dmg", ZIP, "latest-mac.yml"].filter((n) => !names.has(n));
  if (missing.length) fail(`${tag} is missing ${missing.join(", ")}.`, "A published release without these cannot be installed or updated to.");

  // GitHub reports a sha256 per asset, so the cask is filled in without downloading 200 MB to
  // hash. Read off the draft already fetched above: the REST tags endpoint never finds a draft.
  // Missing only if GitHub stops sending it, and then the tap is bumped by hand.
  const digest = release.assets.find((a) => a.name === ZIP)?.digest ?? "";
  const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : null;

  // The one thing worth reading the log for: an un-notarised build downloads and opens for nobody,
  // and nothing else in the release says whether the notary accepted it.
  let notarised = "unknown";
  try {
    notarised = gh("run", "view", String(build.databaseId), "--log").includes("notarization successful") ? "yes" : "NO";
  } catch { /* logs expire; the rest of the checks still stand */ }

  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const isNewest = !tags.some((t) => newer(t, tag));

  // What the workflow writes: the first when it opens the draft, the second once the build is
  // done. Anything else is notes someone wrote on purpose and this must not overwrite them. Both
  // strings live in .github/workflows/release.yml — change either one and change it there too.
  const PLACEHOLDERS = ["Build in progress…", "Built. Not published yet — `pnpm ship` publishes it."];
  const placeholder = !release.body?.trim() || PLACEHOLDERS.includes(release.body.trim());
  const previous = tags.filter((t) => newer(tag, t)).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  // No previous tag on a first release, or in a clone fetched without them — the range would be
  // "undefined..v1" and die with a raw stack after every check had passed.
  // --no-merges: a merge subject is the name of a branch nobody outside this repo has heard of,
  // and the commits it brought in are already in the range on their own.
  const subjects = placeholder && previous
    ? git("log", "--no-merges", `${previous}..${tag}`, "--format=%s").split("\n")
        .filter((s) => s && !/^Release\b/.test(s)).map((s) => `- ${s}`)
    : [];
  const notes = placeholder
    ? (subjects.join("\n") || `Released ${tag}.`)
    : release.body.trim();

  console.log(`\n  draft     ${tag}`);
  console.log(`  build     ${build.conclusion}`);
  console.log(`  assets    ${release.assets.map((a) => `${a.name} ${size(a.size)}`).join("\n            ")}`);
  console.log(`  notarised ${notarised}`);
  console.log(`  latest    ${isNewest ? "yes" : `no — ${tags.filter((t) => newer(t, tag)).join(", ")} is newer`}`);
  console.log(`  tap       ${!isNewest ? "left alone — not the newest" : sha256 ? `${TAP.name} → libratory ${tag.slice(1)}` : "no digest on the zip — bump by hand"}`);
  console.log(`\n  notes${placeholder ? " (from the commits — edit on GitHub if you want better)" : ""}:`);
  console.log(notes.split("\n").map((l) => `    ${l}`).join("\n"));

  if (notarised === "NO") {
    console.log(`\n  This build was NOT notarised. macOS will refuse it and the updater cannot install it.`);
  }

  if (!isNewest) {
    console.log(`\n  ${tag} is older than ${tags.filter((t) => newer(t, tag)).join(", ")}, which is already out.`);
  }

  return { tag, notes, isNewest, sha256, risky: notarised !== "yes" || !isNewest };
}

const plan = main();

// One API call, no clone: the tap is a one-file repository and the file is rendered here. Only the
// newest release moves it — an older draft published late must not roll `brew install` backwards.
// A failure here leaves the release out and says so; the cask is the one thing left to do by hand.
const bumpTap = () => {
  if (!plan.isNewest) return;
  const version = plan.tag.slice(1);
  if (!plan.sha256) {
    console.log(`  Tap not bumped — no digest on ${ZIP}. Hash it and run:  node scripts/cask.mjs ${version} <sha256>\n`);
    return;
  }
  try {
    let existing = null;
    try { existing = JSON.parse(gh("api", `repos/${TAP.repo}/contents/${TAP.path}`)).sha; } catch { /* first bump: nothing to replace */ }
    const content = Buffer.from(renderCask({ version, sha256: plan.sha256 })).toString("base64");
    gh("api", "-X", "PUT", `repos/${TAP.repo}/contents/${TAP.path}`,
      "-f", `message=libratory ${version}`, "-f", `content=${content}`, ...(existing ? ["-f", `sha=${existing}`] : []));
    console.log(`  Tap bumped: brew install --cask ${TAP.name}/libratory now installs ${version}.\n`);
  } catch (error) {
    console.error(`\n  ${plan.tag} is published, but the tap was not updated: ${error.stderr?.toString().trim() || error.message}`);
    console.error(`  Put this in ${TAP.repo} at ${TAP.path}:  node scripts/cask.mjs ${version} ${plan.sha256}\n`);
    process.exit(1);
  }
};

const publish = () => {
  const flags = ["release", "edit", plan.tag, "--draft=false", "--notes-file", "-"];
  // Explicit either way: GitHub's make_latest defaults to true, so an older draft would take the badge.
  flags.push(plan.isNewest ? "--latest" : "--latest=false");
  execFileSync("gh", flags, { cwd: REPO, input: plan.notes, stdio: ["pipe", "inherit", "inherit"] });
  console.log(`\n  Published ${plan.tag}.${plan.isNewest ? " Everyone running an older build will be offered it." : " It is not the latest release, so nobody is offered it as an update."}\n`);
  bumpTap();
};

if (go) {
  publish();
} else if (!process.stdin.isTTY) {
  // No terminal to answer the prompt: readline never resolves and node dies on the pending await.
  fail("Nothing can answer the prompt — stdin is not a terminal.", `pnpm ship --yes publishes ${plan.tag} without asking.`);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = plan.risky ? "  Publish anyway? [y/N] " : "  Publish to everyone? [y/N] ";
  const answer = await rl.question(`\n${question}`);
  rl.close();
  if (answer.trim().toLowerCase() === "y") publish();
  else console.log(`\n  Nothing published. ${plan.tag} is still a draft.\n`);
}
