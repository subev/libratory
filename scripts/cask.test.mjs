import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCask } from "./cask.mjs";

const sha = "db210ceb89ff5f07bf5a29165dd4caffa06e45d2e5b01ff1607604db7be532c8";

test("the version and checksum land where Homebrew reads them", () => {
  const cask = renderCask({ version: "26.911.0", sha256: sha });
  assert.match(cask, /^  version "26\.911\.0"$/m);
  assert.match(cask, new RegExp(`^  sha256 "${sha}"$`, "m"));
  assert.match(cask, /releases\/download\/v#\{version\}\/Libratory-arm64\.zip/);
});

test("a bump changes only the two lines that carry the release", () => {
  const a = renderCask({ version: "26.911.0", sha256: sha }).split("\n");
  const b = renderCask({ version: "26.912.3", sha256: "a".repeat(64) }).split("\n");
  const changed = a.filter((line, i) => line !== b[i]);
  assert.deepEqual(changed, [`  version "26.911.0"`, `  sha256 "${sha}"`]);
});

test("a malformed version or checksum is refused rather than published", () => {
  assert.throws(() => renderCask({ version: "v26.911.0", sha256: sha }), /Not a release version/);
  assert.throws(() => renderCask({ version: "26.911.0", sha256: "sha256:" + sha }), /Not a sha256/);
});
