import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReport } from "./check-python-audit.mjs";

const finding = { id: "GHSA-known", dependency: { name: "example", version: "1.0.0" } };
const exception = { id: finding.id, package: "example", version: "1.0.0", reason: "Upstream compatibility blocker", expires: "2026-10-08" };
const report = (findings = []) => ({ summary: { audited_packages: 2, vulnerabilities: findings.length, adverse_statuses: 0 }, vulnerabilities: findings });

test("a clean report passes without exceptions", () => {
  assert.deepEqual(checkReport(report(), [], "2026-09-08"), { problems: [], deferred: [] });
});
test("a deferred finding remains visible", () => {
  const result = checkReport(report([finding]), [exception], "2026-09-08");
  assert.equal(result.problems.length, 0);
  assert.match(result.deferred[0], /GHSA-known.*deferred/);
});
test("a new advisory or changed package version cannot inherit an exception", () => {
  for (const changed of [{ ...finding, id: "GHSA-new" }, { ...finding, dependency: { name: "example", version: "1.1.0" } }]) {
    assert.equal(checkReport(report([changed]), [exception], "2026-09-08").problems.length, 1);
  }
});
test("exceptions expire even if the advisory disappears", () => {
  assert.equal(checkReport(report(), [exception], "2026-10-08").problems.length, 1);
});
test("service errors and partial reports never pass", () => {
  for (const bad of [{ error: "offline" }, {}, { ...report(), summary: { audited_packages: 0 } }, { ...report(), vulnerabilities: [finding] }]) {
    assert.throws(() => checkReport(bad, [], "2026-09-08"), /Invalid/);
  }
});
test("quarantined or otherwise adverse packages fail", () => {
  const bad = report();
  bad.summary.adverse_statuses = 1;
  assert.equal(checkReport(bad, [], "2026-09-08").problems.length, 1);
});
