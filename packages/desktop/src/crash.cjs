const { app, dialog, shell, clipboard } = require("electron");
const { appendFileSync, readFileSync, existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "https://github.com/subev/libratory";
// GitHub truncates very long querystrings, and a stack tail is more use than a stack head
const MAX_BODY = 4000;

function logPath(home) {
  return path.join(home, "crash.log");
}

function report(err, home, context) {
  const message = String(err?.stack || err?.message || err);
  return {
    when: new Date().toISOString(),
    context,
    message,
    version: app.getVersion(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    home,
  };
}

function asText(r) {
  return [
    `Libratory ${r.version}`,
    `${r.platform}`,
    `${r.when}${r.context ? ` — ${r.context}` : ""}`,
    "",
    r.message,
  ].join("\n");
}

// The log keeps the real paths; an issue is public and a path is only true on this machine.
const scrub = (text) => text.replace(/\/(?:Users|home)\/[^/\s"')]+/g, "~");

function issueUrl(r) {
  const title = `Crash: ${scrub(r.message.split("\n")[0]).slice(0, 90)}`;
  const body = [
    "<!-- What were you doing when this happened? -->",
    "",
    "",
    "---",
    "```",
    asText(r).slice(-MAX_BODY),
    "```",
  ].join("\n");
  return `${REPO}/issues/new?labels=crash&title=${encodeURIComponent(title)}&body=${encodeURIComponent(scrub(body))}`;
}

// Electron's own dialog prints a stack trace and offers OK, which tells someone who did not write
// the app nothing and sends us nothing. This keeps the detail but makes it one click to send.
function show(r) {
  const { response } = dialog.showMessageBoxSync
    ? { response: dialog.showMessageBoxSync({
        type: "error",
        title: "Libratory stopped",
        message: "Libratory hit a problem it could not recover from.",
        detail: `${r.message.split("\n").slice(0, 3).join("\n")}\n\nThe full details are in crash.log. Reporting it opens GitHub with everything filled in — you only have to say what you were doing.`,
        buttons: ["Report this", "Copy details", "Close"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }) }
    : { response: 2 };

  if (response === 0) void shell.openExternal(issueUrl(r));
  if (response === 1) clipboard.writeText(asText(r));
}

function record(err, home, context) {
  const r = report(err, home, context);
  try {
    appendFileSync(logPath(home), `${asText(r)}\n\n`);
  } catch {
    // A crash handler that throws is worse than one that loses a line
  }
  return r;
}

// Installed before anything else can throw, so a failure while working out where HOME is still
// reports — hence the home getter rather than a value.
function install(getHome) {
  process.on("uncaughtException", (err) => {
    show(record(err, getHome(), "main process"));
    app.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    record(err, getHome(), "unhandled rejection");
  });
}

function readLog(home) {
  const p = logPath(home);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

module.exports = { install, record, show, issueUrl, asText, logPath, readLog, REPO };
