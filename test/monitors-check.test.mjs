// governance-check monitors. The manifests are real `dbt parse` output (dbt-core 1.12.6, dbt-duckdb 1.11.1,
// the elementary package 0.26.1) of test/fixtures/governance/monitors/elementary, trimmed to the project's
// own nodes; the GX stores were written by GX Core 1.24.1 through gx/make_context.py, with the UUIDs GX
// generates set to zero (the check matches by name, and the public fact scan rejects a GUID). test/monitors-engine.sh
// regenerates both with the real tools in the self-test and runs the same cases on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "governance-check.mjs");
const FIX = path.join(HERE, "fixtures", "governance", "monitors");
const MAN = (n) => path.join(FIX, "elementary", "manifests", `${n}.json`);
const GX = (v) => path.join(FIX, "gx", v);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mon-"));
const run = (args, cwd = tmp()) => {
  const r = spawnSync(process.execPath, [SCRIPT, "monitors", ...args], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
// an empty repository: no tool configured, so only the input decides
const bare = () => tmp();

test("monitors: every Elementary monitor routed and owned passes", () => {
  const r = run(["--repo", bare(), "--manifest", MAN("pass")]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /monitors: 4 Elementary monitor\(s\), each with an alert destination and an owner/);
});

test("monitors: an Elementary monitor with no channel on the test or its model fails", () => {
  const r = run(["--repo", bare(), "--manifest", MAN("no-route")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\(elementary\.volume_anomalies on customers\): no alert destination/);
  assert.doesNotMatch(r.out, /on orders\)/, "the routed model is not reported");
});

test("monitors: an Elementary monitor whose model has no owner fails", () => {
  const r = run(["--repo", bare(), "--manifest", MAN("no-owner")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\(elementary\.volume_anomalies on orders\): no owner/);
});

test("monitors: a manifest with no Elementary test is NOT CHECKED, exit 2", () => {
  const r = run(["--repo", bare(), "--manifest", MAN("no-monitors")]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /monitors is NOT CHECKED: .* holds no Elementary test/);
});

// Elementary merges the test's meta over the model's: a test that sets channel to "" has no route, even
// though its model has one.
test("monitors: the test's own empty channel or non-name owner is not rescued by the model's", () => {
  const m = JSON.parse(fs.readFileSync(MAN("pass"), "utf8"));
  const id = Object.keys(m.nodes).find((k) => m.nodes[k].test_metadata?.name === "freshness_anomalies");
  m.nodes[id].config.meta = { channel: "", owner: 42 };
  const f = path.join(tmp(), "manifest.json");
  fs.writeFileSync(f, JSON.stringify(m));
  const r = run(["--repo", bare(), "--manifest", f]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /freshness_anomalies on orders\): no alert destination/);
  assert.match(r.out, /freshness_anomalies on orders\): no owner/);
});

test("monitors: channel and owner under alerts_config or legacy top-level meta count", () => {
  const m = JSON.parse(fs.readFileSync(MAN("no-route"), "utf8"));
  const id = Object.keys(m.nodes).find((k) => m.nodes[k].attached_node === "model.monitors_fixture.customers");
  m.nodes[id].meta = { alerts_config: { channel: "customer-alerts" } };
  const f = path.join(tmp(), "manifest.json");
  fs.writeFileSync(f, JSON.stringify(m));
  assert.equal(run(["--repo", bare(), "--manifest", f]).status, 0);
});

test("monitors: GX checkpoints with a notifying action and an owned suite pass; each break fails", () => {
  const ok = run(["--repo", bare(), "--gx", path.join(GX("routed"), "gx")]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /monitors: 1 GX monitor\(s\)/);
  for (const [v, line] of [
    ["no-route", /checkpoint orders_arrived: no alert destination/],
    ["success-only", /checkpoint orders_arrived: no alert destination/],
    ["no-owner", /suite orders_arrived has no owner/],
  ]) {
    const r = run(["--repo", bare(), "--gx", path.join(GX(v), "gx")]);
    assert.equal(r.status, 1, `${v}: ${r.out}`);
    assert.match(r.out, line, v);
  }
});

test("monitors: a GX action with its destination unset, or a suite the checkpoint cannot find, fails", () => {
  const d = path.join(tmp(), "gx");
  fs.cpSync(path.join(GX("routed"), "gx"), d, { recursive: true });
  const cpFile = path.join(d, "checkpoints", "orders_arrived.json");
  const cp = JSON.parse(fs.readFileSync(cpFile, "utf8"));
  cp.actions[0].slack_webhook = null;
  fs.writeFileSync(cpFile, JSON.stringify(cp));
  fs.rmSync(path.join(d, "expectations", "orders_arrived.json"));
  const r = run(["--repo", bare(), "--gx", d]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no alert destination/);
  assert.match(r.out, /suite orders_arrived is not in/);
});

test("monitors: Elementary and GX in one repository fail, however the check is called", () => {
  const both = path.join(FIX, "both");
  for (const extra of [[], ["--manifest", MAN("pass")], ["--gx", path.join(GX("routed"), "gx")]]) {
    const r = run(["--repo", both, ...extra]);
    assert.equal(r.status, 1, `${extra.join(" ")}: ${r.out}`);
    assert.match(r.out, /configures both Elementary \(packages\.yml\) and GX \(requirements\.txt\)/);
  }
  const r = run(["--repo", bare(), "--manifest", MAN("pass"), "--gx", path.join(GX("routed"), "gx")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /both --manifest \(Elementary\) and --gx \(GX\) were given/);
  // a GX context in the repo, checked as Elementary: still both
  const e = run(["--repo", GX("routed"), "--manifest", MAN("pass")]);
  assert.equal(e.status, 1, e.out);
  assert.match(e.out, /configures GX \(gx\/great_expectations\.yml\)/);
});

test("monitors: tool detection reads dependency files, ignores comments and installed packages", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  # - package: elementary-data/elementary\n  - package: dbt-labs/dbt_utils\n");
  fs.mkdirSync(path.join(d, "dbt_packages", "x"), { recursive: true });
  fs.writeFileSync(path.join(d, "dbt_packages", "x", "requirements.txt"), "great_expectations\n");
  let r = run(["--repo", d]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /NOT CHECKED: neither Elementary nor GX is configured/);
  fs.writeFileSync(path.join(d, "pyproject.toml"), '[project]\ndependencies = ["great-expectations==1.24.1"]\n');
  r = run(["--repo", d]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /NOT CHECKED: GX is configured; pass --gx/);
  fs.writeFileSync(path.join(d, "requirements-dev.txt"), "elementary-data==0.26.1\n");
  r = run(["--repo", d]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Elementary \(requirements-dev\.txt\) and GX \(pyproject\.toml\)/);
});

test("monitors: Elementary configured with no manifest is NOT CHECKED, never a pass", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n    version: 0.26.1\n");
  const r = run(["--repo", d]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /NOT CHECKED: Elementary is configured; pass --manifest/);
});

test("monitors: bad input exits 2", () => {
  const notManifest = path.join(tmp(), "m.json");
  fs.writeFileSync(notManifest, JSON.stringify({ nodes: {} }));
  const emptyGx = path.join(tmp(), "gx");
  fs.mkdirSync(path.join(emptyGx, "checkpoints"), { recursive: true });
  for (const [args, msg] of [
    [["--manfest", MAN("pass")], /unknown flag: --manfest/],
    [["--manifest", MAN("pass"), "--manifest", MAN("pass")], /--manifest given twice/],
    [["--manifest"], /--manifest needs a value/],
    [["--repo", path.join(tmp(), "nope"), "--manifest", MAN("pass")], /--repo .*: no such directory/],
    [["--repo", bare(), "--manifest", path.join(tmp(), "missing.json")], /no such file/],
    [["--repo", bare(), "--manifest", notManifest], /not a dbt manifest/],
    [["--repo", bare(), "--gx", path.join(tmp(), "nope")], /--gx .*: no such directory/],
    [["--repo", bare(), "--gx", emptyGx], /NOT CHECKED: .* holds no checkpoint/],
    [["stray"], /unexpected argument: stray/],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, msg, args.join(" "));
  }
});
