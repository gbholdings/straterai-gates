// scripts/run-governance-checks.sh (governance.yml's check step) and scripts/version-check.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { versionCheck, expectedVersion } from "../scripts/version-check.mjs";
import { VERSION } from "../scripts/governance-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gov-run-"));
const posix = process.platform !== "win32";

function runChecks(checks) {
  const d = tmp();
  const evidence = path.join(d, "evidence.json");
  const env = { ...process.env, CHECKS: checks, GC: path.join(SCRIPTS, "governance-check.mjs"), GOVERNANCE_EVIDENCE_FILE: evidence, RUN_LINK: "https://example.invalid/run/1", COMMIT: "0".repeat(40), GITHUB_OUTPUT: path.join(d, "out") };
  delete env.BASH_ENV;
  delete env.ENV;
  const r = spawnSync("bash", [path.join(SCRIPTS, "run-governance-checks.sh")], { cwd: d, env, encoding: "utf8" });
  const entries = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, "utf8")) : [];
  return { status: r.status, out: r.stdout + r.stderr, entries };
}
const resultOf = (entries, check) => entries.filter((e) => e.check === check).map((e) => e.result);

// review finding 6: exit 2 is NOT CHECKED, recorded as not_run, and still fails the job
test("run-governance-checks: exit 0 records pass, exit 2 not_run, exit 1 fail; anything but pass fails", { skip: !posix && "bash" }, () => {
  const bare = tmp();
  const both = tmp();
  fs.writeFileSync(path.join(both, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n");
  fs.writeFileSync(path.join(both, "requirements.txt"), "great_expectations\n");
  const r = runChecks([`t:a/version=version`, `t:a/unchecked=monitors --repo ${bare}`, `t:a/broken=monitors --repo ${both}`].join("\n"));
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(resultOf(r.entries, "t:a/version"), ["pass"], r.out);
  assert.deepEqual(resultOf(r.entries, "t:a/unchecked"), ["not_run"], r.out);
  assert.deepEqual(resultOf(r.entries, "t:a/broken"), ["fail"], r.out);
  assert.match(r.out, /::error::t:a\/unchecked was NOT CHECKED \(exit 2\)/);
  const ok = runChecks("t:a/version=version");
  assert.equal(ok.status, 0, ok.out);
});

// review finding 5: whatever a check prints sits between ::stop-commands:: and its resume token
test("run-governance-checks: a check's output cannot issue a workflow command", { skip: !posix && "a newline in a file name needs a POSIX file system" }, () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n");
  const evil = path.join(d, "x\n::warning title=injected::owned");
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, "great_expectations.yml"), "config_version: 4\n");
  const r = runChecks(`t:a/m=monitors --repo ${d}`);
  const lines = r.out.split("\n");
  const stop = lines.findIndex((l) => /^::stop-commands::gates-[0-9a-f]{32}$/.test(l));
  assert.ok(stop >= 0, r.out);
  const token = lines[stop].slice("::stop-commands::".length);
  const resume = lines.indexOf(`::${token}::`);
  assert.ok(resume > stop, r.out);
  assert.ok(lines.slice(stop + 1, resume).some((l) => /configures both/.test(l)), r.out);
  for (const l of lines.slice(stop + 1, resume)) assert.doesNotMatch(l, /^\s*::/, l);
});

test("version-check: VERSION must be next-tag.mjs of the PR's semver label on the current tags", () => {
  assert.equal(expectedVersion(["hold", "semver:minor"], ["v1.0.0", "v1.1.0", "v1.2.0"]), "1.3.0");
  // gates#11 merged first and cut v1.3.0: this PR's minor bump is now 1.4.0, and 1.3.0 is wrong
  assert.throws(() => versionCheck("1.3.0", ["semver:minor"], ["v1.2.0", "v1.3.0"]), /VERSION is 1\.3\.0, and this PR will be tagged v1\.4\.0/);
  assert.match(versionCheck("1.4.0", ["semver:minor"], ["v1.2.0", "v1.3.0"]), /VERSION 1\.4\.0 is the tag this PR will get/);
  assert.equal(expectedVersion(["semver:patch"], ["v1.10.0", "v1.9.0"]), "1.10.1");
  assert.throws(() => expectedVersion(["tier:red"], ["v1.2.0"]), /exactly one label/);
  assert.throws(() => expectedVersion(["semver:minor", "semver:patch"], ["v1.2.0"]), /exactly one label/);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("version-check: the CLI reads PR_LABELS and the repository's tags", { skip: !posix && "git" }, () => {
  const repo = tmp();
  const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { encoding: "utf8" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");
  const [M, m] = VERSION.split(".").map(Number);
  git("tag", `v${M}.${m - 1}.0`);
  const cli = (labels) => spawnSync(process.execPath, [path.join(SCRIPTS, "version-check.mjs")], { cwd: repo, encoding: "utf8", env: { ...process.env, PR_LABELS: labels } });
  assert.equal(cli('["semver:minor"]').status, 0);
  assert.equal(cli('["semver:major"]').status, 1);
  assert.equal(cli("[]").status, 2);
  assert.equal(cli("not json").status, 2);
});
