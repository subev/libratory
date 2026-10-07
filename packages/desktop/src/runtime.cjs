const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Replacing the app bundle swaps the shell, our JavaScript and the server binary — about 180 MB —
// and leaves the ~2.4 GB Python environment and the models at whatever the previous release
// installed. This is the record of what is actually out here, so a launch can tell.
//
// Migrations are deliberately absent: the server applies its own at boot, which also gets the
// ordering right for free — it cannot start against a database it is newer than.
const STATE_FILE = "runtime-state.json";

function hashOf(file) {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "";
}

// Derived from the shipped lockfile rather than a hand-maintained version number, because the
// release that forgets to bump a counter is exactly the one that ships a mismatched runtime.
function wanted(resources) {
  return {
    pythonLock: hashOf(path.join(resources, "uv.lock")),
    piperLock: hashOf(path.join(resources, "scripts", "requirements-piper.txt")),
  };
}

function readState(home) {
  try {
    return JSON.parse(readFileSync(path.join(home, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}

// Written only after a step succeeds, so an interrupted update repeats rather than being skipped
function writeState(home, patch) {
  const next = { ...readState(home), ...patch };
  writeFileSync(path.join(home, STATE_FILE), JSON.stringify(next, null, 2));
  return next;
}

function pending(resources, home) {
  const want = wanted(resources);
  const have = readState(home);
  return {
    want,
    // No recorded state at all is a first run, which needs the same work for a different reason
    python: want.pythonLock !== have.pythonLock,
    piper: want.piperLock !== have.piperLock,
    models: !have.essentialModels,
    fresh: have.pythonLock === undefined,
  };
}

module.exports = { wanted, readState, writeState, pending, STATE_FILE };
