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
  const names = release.assets.map((a) => a.name);
  const missing = ["Libratory-arm64.dmg", "Libratory-arm64.zip", "latest-mac.yml"].filter((n) => !names.includes(n));
  if (missing.length) fail(`${tag} is missing ${missing.join(", ")}.`, "A published release without these cannot be installed or updated to.");

  // The one thing worth reading the log for: an un-notarised build downloads and opens for nobody,
  // and nothing else in the release says whether the notary accepted it.
  let notarised = "unknown";
  try {
    notarised = gh("run", "view", String(build.databaseId), "--log").includes("notarization successful") ? "yes" : "NO";
  } catch { /* logs expire; the rest of the checks still stand */ }

  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  const isNewest = !tags.some((t) => newer(t, tag));

  // The workflow opens every draft with this, so anything else is notes someone wrote on purpose.
  const placeholder = !release.body?.trim() || release.body.trim() === "Build in progress…";
  const previous = tags.filter((t) => newer(tag, t)).sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  // No previous tag on a first release, or in a clone fetched without them — the range would be
  // "undefined..v1" and die with a raw stack after every check had passed.
  const subjects = placeholder && previous
    ? git("log", `${previous}..${tag}`, "--format=%s").split("\n")
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
  console.log(`\n  notes${placeholder ? " (from the commits — edit on GitHub if you want better)" : ""}:`);
  console.log(notes.split("\n").map((l) => `    ${l}`).join("\n"));

  if (notarised === "NO") {
    console.log(`\n  This build was NOT notarised. macOS will refuse it and the updater cannot install it.`);
  }

  return { tag, notes, isNewest, risky: notarised !== "yes" };
}

const plan = main();

const publish = () => {
  const flags = ["release", "edit", plan.tag, "--draft=false", "--notes-file", "-"];
  if (plan.isNewest) flags.push("--latest");
  execFileSync("gh", flags, { cwd: REPO, input: plan.notes, stdio: ["pipe", "inherit", "inherit"] });
  console.log(`\n  Published ${plan.tag}. Everyone running an older build will be offered it.\n`);
};

if (go) {
  publish();
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = plan.risky ? "  Publish anyway? [y/N] " : "  Publish to everyone? [y/N] ";
  const answer = await rl.question(`\n${question}`);
  rl.close();
  if (answer.trim().toLowerCase() === "y") publish();
  else console.log(`\n  Nothing published. ${plan.tag} is still a draft.\n`);
}
