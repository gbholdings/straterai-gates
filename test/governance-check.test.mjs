import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "governance-check.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gov-"));
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
const append = (cwd, extra = []) =>
  run(["evidence", "append", "--check", "data:db-migrate/squawk", "--result", "pass", "--commit", "abc123", ...extra], cwd);

test("version prints and exits 0", () => {
  const r = run(["version"], tmp());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("append to a missing file creates an array of one", () => {
  const d = tmp();
  const r = append(d, ["--detail", "ok"]);
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(d, "governance/evidence.json"), "utf8"));
  assert.equal(a.length, 1);
  assert.deepEqual(Object.keys(a[0]), ["check", "date", "result", "run_link", "commit", "detail"]);
  assert.equal(a[0].run_link, null);
  assert.equal(a[0].commit, "abc123");
  assert.match(a[0].date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
});

test("append never drops an earlier entry", () => {
  const d = tmp();
  for (let i = 0; i < 3; i++) assert.equal(append(d, ["--detail", `n${i}`]).status, 0);
  const before = JSON.parse(fs.readFileSync(path.join(d, "governance/evidence.json"), "utf8"));
  assert.equal(append(d, ["--detail", "n3", "--run-link", "https://example.test/run/1"]).status, 0);
  const after = JSON.parse(fs.readFileSync(path.join(d, "governance/evidence.json"), "utf8"));
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(0, 3), before);
  assert.equal(after[3].run_link, "https://example.test/run/1");
});

test("an earlier entry with extra fields survives untouched", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "governance"));
  const old = { check: "x:y/z", result: "fail", note: "kept", nested: { a: [1, 2] } };
  fs.writeFileSync(path.join(d, "governance/evidence.json"), JSON.stringify([old]));
  assert.equal(append(d).status, 0);
  const a = JSON.parse(fs.readFileSync(path.join(d, "governance/evidence.json"), "utf8"));
  assert.deepEqual(a[0], old);
});

for (const [name, body] of [
  ["malformed JSON", "[{\"check\": "],
  ["an empty file", ""],
  ["an object, not an array", "{\"a\":1}"],
  ["an array holding a non-object", "[1]"],
]) {
  test(`a malformed file (${name}) exits 4 and is left untouched`, () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "governance"));
    const f = path.join(d, "governance/evidence.json");
    fs.writeFileSync(f, body);
    const r = append(d);
    assert.equal(r.status, 4);
    assert.equal(fs.readFileSync(f, "utf8"), body);
    assert.deepEqual(fs.readdirSync(path.join(d, "governance")), ["evidence.json"]);
  });
}

test("usage errors exit 2 and write nothing", () => {
  const d = tmp();
  assert.equal(run(["evidence", "append", "--result", "pass"], d).status, 2);
  assert.equal(run(["evidence", "append", "--check", "a:b/c", "--result", "compliant"], d).status, 2);
  assert.equal(run(["evidence", "append", "--check", "a:b/c", "--result", "pass", "--nope", "1"], d).status, 2);
  assert.equal(run(["evidence", "append", "--check", "a:b/c", "--result", "pass", "--date", "yesterday-ish"], d).status, 2);
  assert.equal(run(["bogus"], d).status, 2);
  assert.equal(fs.existsSync(path.join(d, "governance")), false);
});

test("--file and GOVERNANCE_EVIDENCE_FILE choose the path", () => {
  const d = tmp();
  assert.equal(append(d, ["--file", "out/e.json"]).status, 0);
  assert.equal(fs.existsSync(path.join(d, "out/e.json")), true);
});

// next-tag
import { nextTag } from "../scripts/next-tag.mjs";
test("next-tag: first release is v1.0.0, then bumps by label", () => {
  assert.equal(nextTag("patch", []), "v1.0.0");
  assert.equal(nextTag("patch", ["v1.0.0"]), "v1.0.1");
  assert.equal(nextTag("minor", ["v1.0.0", "v1.0.9", "v0.9.0"]), "v1.1.0");
  assert.equal(nextTag("major", ["v1.9.2", "v1.10.0"]), "v2.0.0");
  assert.equal(nextTag("minor", ["v1.9.2", "v1.10.0", "not-a-tag"]), "v1.11.0");
  assert.throws(() => nextTag("huge", ["v1.0.0"]));
});

// publish-evidence.sh against a local bare remote
test("publish-evidence creates the branch, then appends to it, writing only that file", () => {
  const root = tmp();
  const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  const bare = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const work = path.join(root, "work");
  git(root, "clone", "-q", bare, work);
  git(work, "config", "user.name", "t");
  git(work, "config", "user.email", "t@example.test");
  fs.writeFileSync(path.join(work, "README.md"), "x");
  git(work, "add", ".");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", "origin", "HEAD:main");
  const sh = path.join(path.dirname(SCRIPT), "publish-evidence.sh");
  const publish = (file) =>
    spawnSync("bash", [sh], { cwd: work, encoding: "utf8", env: { ...process.env, EVIDENCE_FILE: file, EVIDENCE_BRANCH: "governance-evidence" } });
  const f1 = path.join(root, "e1.json");
  fs.writeFileSync(f1, JSON.stringify([{ check: "a:b/c" }]));
  let r = publish(f1);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(bare, "ls-tree", "-r", "--name-only", "governance-evidence").stdout.trim(), "governance/evidence.json");
  const f2 = path.join(root, "e2.json");
  fs.writeFileSync(f2, JSON.stringify([{ check: "a:b/c" }, { check: "d:e/f" }]));
  r = publish(f2);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(bare, "rev-list", "--count", "governance-evidence").stdout.trim(), "2");
  assert.equal(git(bare, "ls-tree", "-r", "--name-only", "governance-evidence").stdout.trim(), "governance/evidence.json");
  assert.equal(JSON.parse(git(bare, "show", "governance-evidence:governance/evidence.json").stdout).length, 2);
  r = publish(f2);
  assert.match(r.stdout, /unchanged/);
});
