#!/usr/bin/env node
// Dependency audit gate.
//
// Runs `npm audit` over PRODUCTION dependencies only (`--omit=dev`) and fails
// the job when a high or critical advisory has a fix we could take today
// without a major-version bump. Everything else is reported, never blocking:
//
//   - high/critical, fix available, non-major  -> FAIL (exit 1)
//   - high/critical, fix requires a major bump -> warning (a human decision)
//   - high/critical, no fix published          -> warning (nothing to take)
//   - moderate/low                              -> informational
//
// The distinction matters because this runs in front of production deploys:
// a transitive CVE with no upstream fix must not block a hotfix, and a
// major-only fix is a design decision, not something a red check should force
// at deploy time. The monthly dependency Routine picks both of those up.
//
// Emergency bypass for a single advisory: AUDIT_GATE_IGNORE=GHSA-xxxx,GHSA-yyyy
// (comma-separated advisory ids). Use it in the workflow env with a comment
// naming why, and remove it the moment the fix lands.
import { spawnSync } from "node:child_process";

const ignore = new Set(
  (process.env.AUDIT_GATE_IGNORE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const res = spawnSync("npm", ["audit", "--json", "--omit=dev"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
// npm audit exits 1 whenever any vulnerability exists; the JSON is still on
// stdout. Only a missing/unparseable body is a tooling failure.
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error("audit-gate: could not parse `npm audit --json` output");
  console.error(res.stderr || res.stdout);
  process.exit(2);
}
if (report.error) {
  console.error("audit-gate: npm audit failed:", report.error.summary ?? report.error);
  process.exit(2);
}

const vulns = Object.values(report.vulnerabilities ?? {});
const blocking = [];
const warnings = [];
const info = [];

for (const v of vulns) {
  const advisories = (v.via ?? []).filter((x) => typeof x === "object");
  const ids = advisories.map((a) => a.url?.split("/").pop() ?? a.source);
  const titles = advisories.map((a) => a.title).join("; ");
  const line = `${v.severity.padEnd(8)} ${v.name}@${v.range}  ${titles}${ids.length ? `  [${ids.join(", ")}]` : ""}`;
  if (ids.length && ids.every((id) => ignore.has(String(id)))) {
    warnings.push(`IGNORED via AUDIT_GATE_IGNORE: ${line}`);
    continue;
  }
  const severe = v.severity === "high" || v.severity === "critical";
  if (!severe) {
    info.push(line);
    continue;
  }
  const fix = v.fixAvailable;
  if (fix === true) blocking.push(`${line}  (fix: npm audit fix)`);
  else if (fix && typeof fix === "object" && !fix.isSemVerMajor)
    blocking.push(`${line}  (fix: ${fix.name}@${fix.version})`);
  else if (fix && typeof fix === "object")
    warnings.push(`${line}  (fix needs MAJOR bump: ${fix.name}@${fix.version})`);
  else warnings.push(`${line}  (no fix published)`);
}

const m = report.metadata?.vulnerabilities ?? {};
console.log(
  `audit-gate: production deps — critical ${m.critical ?? 0}, high ${m.high ?? 0}, moderate ${m.moderate ?? 0}, low ${m.low ?? 0}`,
);
for (const l of info) console.log(`  info     ${l}`);
for (const l of warnings) console.log(`::warning::audit-gate: ${l}`);
for (const l of blocking) console.log(`::error::audit-gate: ${l}`);

if (blocking.length) {
  console.error(
    `\naudit-gate: ${blocking.length} high/critical advisor${blocking.length === 1 ? "y has" : "ies have"} a non-major fix available. Run \`npm audit fix\` (or bump the named package) and commit the lockfile.`,
  );
  process.exit(1);
}
console.log("audit-gate: OK");
