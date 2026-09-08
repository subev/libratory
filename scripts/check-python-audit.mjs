import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// uv's JSON format is experimental. Fail closed if it changes or the service returns an error.
export function checkReport(report, exceptions, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(report?.vulnerabilities) || !Number.isInteger(report?.summary?.audited_packages)
      || report.summary.audited_packages <= 0
      || report.summary.vulnerabilities !== report.vulnerabilities.length
      || !Number.isInteger(report.summary.adverse_statuses)) {
    throw new Error("Invalid or incomplete uv audit report");
  }
  if (!Array.isArray(exceptions)) throw new Error("Invalid exception list");
  const problems = [];
  const deferred = [];
  for (const entry of exceptions) {
    if (!entry.id || !entry.package || !entry.version || !entry.reason?.trim()
        || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      throw new Error("An audit exception needs an ID, package, version, reason, and expiry");
    }
    if (entry.expires <= today) problems.push(`Expired exception: ${entry.id}`);
  }
  for (const finding of report.vulnerabilities) {
    if (!finding.id || !finding.dependency?.name || !finding.dependency.version) {
      throw new Error("Invalid vulnerability in uv audit report");
    }
    const entry = exceptions.find((e) => e.id === finding.id
      && e.package === finding.dependency.name && e.version === finding.dependency.version
      && e.expires > today);
    const label = `${finding.dependency.name}@${finding.dependency.version}: ${finding.id}`;
    if (entry) deferred.push(`${label} — deferred until ${entry.expires}: ${entry.reason}`);
    else problems.push(label);
  }
  if (report.summary.adverse_statuses > 0) problems.push(`${report.summary.adverse_statuses} adverse package statuses`);
  return { problems, deferred };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2];
  if (!reportPath) throw new Error("Usage: node scripts/check-python-audit.mjs <uv-audit.json>");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const exceptions = JSON.parse(readFileSync(new URL("./python-audit-exceptions.json", import.meta.url), "utf8"));
  const { problems, deferred } = checkReport(report, exceptions);
  for (const line of deferred) console.log(line);
  for (const line of problems) console.error(line);
  console.log(`${report.summary.audited_packages} packages audited; ${deferred.length} deferred findings; ${problems.length} require action.`);
  process.exitCode = problems.length ? 1 : 0;
}
