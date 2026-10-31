// governance-check monitors. The manifests are real `dbt parse` output (dbt-core 1.12.6, dbt-duckdb 1.11.1,
// the elementary package 0.26.1) of test/fixtures/governance/monitors/elementary, trimmed to the project's
// own nodes, with metadata.project_name and a fixed generated_at; the GX stores were written by GX Core
// 1.24.1 through gx/make_context.py, with the UUIDs GX generates set to zero (the check matches by name, and
// the public fact scan rejects a GUID). test/monitors-engine.sh regenerates both with the real tools in the
// self-test, loads every GX context in GX itself, and runs the same cases on them. Here a stub stands in for
// the GX Python, so these tests prove the check's own logic, not GX's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPlaceholder, q } from "../scripts/governance-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "governance-check.mjs");
const FIX = path.join(HERE, "fixtures", "governance", "monitors");
const MAN = (n) => path.join(FIX, "elementary", "manifests", `${n}.json`);
const GX = (v) => path.join(FIX, "gx", v);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mon-"));
const posix = process.platform !== "win32";
const run = (args, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, "monitors", ...args], { cwd: tmp(), encoding: "utf8", env: { ...process.env, GATES_GX_PYTHON: "", ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
// Every file under d set to a minute before `iso`, as a checkout made before the parse would be.
const age = (d, iso) => {
  const t = new Date(Date.parse(iso) - 60_000);
  for (const f of walk(d)) fs.utimesSync(f, t, t);
};

// A copy of the dbt fixture project (with a variant's overlay) holding the committed manifest for that
// variant as target/manifest.json, every file older than the manifest: what a fresh `dbt parse` leaves.
function project(variant = "pass", edit, into = tmp()) {
  fs.cpSync(path.join(FIX, "elementary", "project"), into, { recursive: true });
  if (variant !== "pass") fs.cpSync(path.join(FIX, "elementary", variant), into, { recursive: true });
  const m = JSON.parse(fs.readFileSync(MAN(variant), "utf8"));
  edit?.(m);
  age(into, m.metadata.generated_at);
  fs.mkdirSync(path.join(into, "target"), { recursive: true });
  const mf = path.join(into, "target", "manifest.json");
  fs.writeFileSync(mf, JSON.stringify(m));
  return { d: into, mf, m };
}
const el = (variant, edit) => {
  const p = project(variant, edit);
  return { ...p, args: ["--repo", p.d, "--manifest", p.mf] };
};
const testNode = (m, name) => m.nodes[Object.keys(m.nodes).find((k) => m.nodes[k].test_metadata?.name === name)];

// A stand-in for the GX Python: prints the line the check reads, loading every checkpoint, or the error given.
function gxStub(error = null, cpError = null) {
  const f = path.join(tmp(), "python");
  const out = JSON.stringify({ error, checkpoints: { orders_arrived: cpError } });
  fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' 'GATES-GX-LOAD ${out}'\n`, { mode: 0o755 });
  return f;
}
// A copy of a GX fixture repository, so a test may edit it.
const gxRepo = (v) => {
  const d = tmp();
  fs.cpSync(GX(v), d, { recursive: true });
  return d;
};

test("monitors: every Elementary monitor routed and owned passes", () => {
  const r = run(el("pass").args);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /monitors: 4 Elementary monitor\(s\), each with an alert destination and an owner/);
});

test("monitors: an Elementary monitor with no channel on the test or its model fails", () => {
  const r = run(el("no-route").args);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\(elementary\.volume_anomalies on customers\): no alert destination/);
  assert.doesNotMatch(r.out, /on orders\)/, "the routed model is not reported");
});

test("monitors: an Elementary monitor whose model has no owner fails", () => {
  const r = run(el("no-owner").args);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /\(elementary\.volume_anomalies on orders\): no owner/);
});

test("monitors: a manifest with no Elementary test is NOT CHECKED, exit 2", () => {
  const r = run(el("no-monitors").args);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /holds no Elementary test/);
});

// Elementary merges the test's meta over the model's: a test that sets channel to "" has no route, even
// though its model has one.
test("monitors: the test's own empty channel or non-name owner is not rescued by the model's", () => {
  const r = run(el("pass", (m) => (testNode(m, "freshness_anomalies").config.meta = { channel: "", owner: 42 })).args);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /freshness_anomalies on orders\): no alert destination/);
  assert.match(r.out, /freshness_anomalies on orders\): no owner/);
});

test("monitors: channel and owner under alerts_config or legacy top-level meta count", () => {
  const r = run(
    el("no-route", (m) => {
      const id = Object.keys(m.nodes).find((k) => m.nodes[k].attached_node === "model.monitors_fixture.customers");
      m.nodes[id].meta = { alerts_config: { channel: "customer-alerts" } };
    }).args,
  );
  assert.equal(r.status, 0, r.out);
});

// review finding 1: a manifest that is not a current parse of the repository is NOT CHECKED
test("monitors: a model added after the parse makes the manifest stale, NOT CHECKED", () => {
  const p = el("pass");
  fs.writeFileSync(path.join(p.d, "models", "payments.sql"), "select 1 as id\n");
  fs.appendFileSync(path.join(p.d, "models", "schema.yml"), "  - name: payments\n    data_tests:\n      - elementary.volume_anomalies\n");
  const r = run(p.args);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /is not a current parse of .*models\/payments\.sql is not in the manifest/);
  assert.match(r.out, /changed after the manifest was written/);
});

test("monitors: a stale manifest is caught by content even when mtimes say it is fresh", () => {
  const p = el("pass");
  fs.writeFileSync(path.join(p.d, "models", "orders.sql"), "select 2 as order_id\n");
  age(path.join(p.d, "models"), p.m.metadata.generated_at);
  const r = run(p.args);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /models\/orders\.sql has changed since the manifest was written/);
});

test("monitors: a schema.yml edited after the parse is caught by its mtime", () => {
  const p = el("pass");
  const y = path.join(p.d, "models", "schema.yml");
  fs.writeFileSync(y, fs.readFileSync(y, "utf8").replace(/channel: .*/g, 'channel: ""'));
  const r = run(p.args);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /models\/schema\.yml changed after the manifest was written/);
});

test("monitors: a manifest of another project, or of the same name over other files, is NOT CHECKED", () => {
  const other = el("pass");
  fs.writeFileSync(path.join(other.d, "dbt_project.yml"), fs.readFileSync(path.join(other.d, "dbt_project.yml"), "utf8").replace("name: monitors_fixture", "name: someone_else"));
  age(other.d, other.m.metadata.generated_at);
  let r = run(["--repo", other.d, "--manifest", other.mf]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /dbt project monitors_fixture, and --repo holds no dbt project of that name/);
  const sameName = tmp();
  fs.writeFileSync(path.join(sameName, "dbt_project.yml"), "name: monitors_fixture\nprofile: x\n");
  fs.mkdirSync(path.join(sameName, "models"));
  fs.writeFileSync(path.join(sameName, "models", "orders.sql"), "select 'different' as x\n");
  age(sameName, other.m.metadata.generated_at);
  r = run(["--repo", sameName, "--manifest", el("pass").mf]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /orders\.sql has changed since the manifest was written|is in the manifest and not in/);
});

// review finding 4: every dbt project that uses Elementary is covered
test("monitors: a second dbt project with Elementary and no manifest is NOT CHECKED", () => {
  const repo = tmp();
  const first = project("pass", undefined, path.join(repo, "first"));
  project("no-route", undefined, path.join(repo, "second"));
  const r = run(["--repo", repo, "--manifest", first.mf]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /dbt project second uses Elementary and no --manifest covers it/);
  const both = run(["--repo", repo, "--manifest", first.mf, "--manifest", path.join(repo, "second", "target", "manifest.json")]);
  assert.equal(both.status, 1, both.out);
  assert.match(both.out, /volume_anomalies on customers\): no alert destination/);
});

// review finding 2: placeholders are not owners or channels
test("monitors: placeholder owners and channels fail", () => {
  for (const [channel, owner] of [
    ["tbd", "TODO"],
    ["#", "<owner>"],
    ["none", "example-team"],
    ["#todo", "n/a"],
    ["  ", "@"],
  ]) {
    const r = run(el("pass", (m) => (testNode(m, "freshness_anomalies").config.meta = { channel, owner })).args);
    assert.equal(r.status, 1, `${channel}/${owner}: ${r.out}`);
    assert.match(r.out, /freshness_anomalies on orders\): (alert destination is a placeholder|no alert destination)/, channel);
    assert.match(r.out, /freshness_anomalies on orders\): (owner is a placeholder|no owner)/, owner);
  }
  for (const real of ["data-platform", "#data-alerts", "@finance-data", "alerts@data-team.test"]) assert.equal(isPlaceholder(real), false, real);
});

// review finding 3: routes that cannot deliver
test("monitors: an alert suppression interval past a week, or not a number, fails", () => {
  for (const v of [100000, "forever"]) {
    const r = run(el("pass", (m) => (testNode(m, "freshness_anomalies").config.meta.alert_suppression_interval = v)).args);
    assert.equal(r.status, 1, `${v}: ${r.out}`);
    assert.match(r.out, /freshness_anomalies on orders\): alert_suppression_interval/);
  }
  assert.equal(run(el("pass", (m) => (testNode(m, "freshness_anomalies").config.meta.alert_suppression_interval = 24)).args).status, 0);
});

test("monitors: GX checkpoints with a notifying action and an owned suite pass once GX loads them; each break fails", { skip: !posix && "the GX stub is a shell script" }, () => {
  const ok = run(["--repo", GX("routed"), "--gx", path.join(GX("routed"), "gx"), "--gx-python", gxStub()]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /monitors: 1 GX monitor\(s\)/);
  for (const [v, line] of [
    ["no-route", /checkpoint orders_arrived: no deliverable alert destination/],
    ["success-only", /checkpoint orders_arrived: no deliverable alert destination/],
    ["no-owner", /suite orders_arrived has no owner/],
  ]) {
    const r = run(["--repo", GX(v), "--gx", path.join(GX(v), "gx"), "--gx-python", gxStub()]);
    assert.equal(r.status, 1, `${v}: ${r.out}`);
    assert.match(r.out, line, v);
  }
});

test("monitors: a GX context not loaded in GX is NOT CHECKED; one GX refuses fails", { skip: !posix && "the GX stub is a shell script" }, () => {
  const args = ["--repo", GX("routed"), "--gx", path.join(GX("routed"), "gx")];
  let r = run(args);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /was not loaded in GX \(pass --gx-python/);
  r = run([...args, "--gx-python", gxStub(null, "ValidationError: smtp_address none is not an allowed value")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /checkpoint orders_arrived: GX refuses to load it: ValidationError/);
  r = run([...args, "--gx-python", gxStub("InvalidDataContextConfigError: bad")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /GX refuses to load it: InvalidDataContextConfigError/);
  r = run(args, { GATES_GX_PYTHON: gxStub() });
  assert.equal(r.status, 0, r.out);
});

test("monitors: a GX action without every field its delivery needs, or a placeholder owner, fails", { skip: !posix && "the GX stub is a shell script" }, () => {
  const d = gxRepo("routed");
  const cpFile = path.join(d, "gx", "checkpoints", "orders_arrived.json");
  const sFile = path.join(d, "gx", "expectations", "orders_arrived.json");
  const cp0 = JSON.parse(fs.readFileSync(cpFile, "utf8"));
  const s0 = JSON.parse(fs.readFileSync(sFile, "utf8"));
  const runWith = (action, owner = "data-platform") => {
    fs.writeFileSync(cpFile, JSON.stringify({ ...cp0, actions: [{ name: "a", notify_on: "failure", ...action }] }));
    fs.writeFileSync(sFile, JSON.stringify({ ...s0, meta: { owner } }));
    return run(["--repo", d, "--gx", path.join(d, "gx"), "--gx-python", gxStub()]);
  };
  for (const a of [
    { type: "email", receiver_emails: "oncall@data-team.test", smtp_address: null, smtp_port: "587" },
    { type: "slack", slack_channel: "#data-alerts" },
    { type: "slack", slack_webhook: null },
  ]) {
    const r = runWith(a);
    assert.equal(r.status, 1, `${JSON.stringify(a)}: ${r.out}`);
    assert.match(r.out, /no deliverable alert destination/);
  }
  assert.equal(runWith({ type: "email", receiver_emails: "oncall@data-team.test", smtp_address: "smtp.data-team.test", smtp_port: "587" }).status, 0);
  assert.equal(runWith({ type: "slack", slack_token: "${SLACK_TOKEN}", slack_channel: "#data-alerts" }).status, 0);
  const r = runWith({ type: "slack", slack_webhook: "${SLACK_WEBHOOK}" }, "TODO");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /suite orders_arrived owner is a placeholder/);
  runWith({ type: "slack", slack_webhook: "${SLACK_WEBHOOK}" });
  fs.rmSync(sFile);
  const gone = run(["--repo", d, "--gx", path.join(d, "gx"), "--gx-python", gxStub()]);
  assert.equal(gone.status, 1, gone.out);
  assert.match(gone.out, /suite orders_arrived is not in/);
});

// review finding 4: every GX context is covered, and a --gx outside the repository covers nothing
test("monitors: a second GX context with no --gx, or a --gx outside --repo, is NOT CHECKED", { skip: !posix && "the GX stub is a shell script" }, () => {
  const d = gxRepo("routed");
  fs.cpSync(path.join(GX("no-route"), "gx"), path.join(d, "jobs", "gx"), { recursive: true });
  let r = run(["--repo", d, "--gx", path.join(d, "gx"), "--gx-python", gxStub()]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /GX context jobs\/gx is not covered by a --gx/);
  r = run(["--repo", gxRepo("routed"), "--gx", path.join(GX("routed"), "gx"), "--gx-python", gxStub()]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /is not a GX context under --repo/);
});

test("monitors: Elementary and GX in one repository fail, however the check is called", () => {
  const both = path.join(FIX, "both");
  const p = el("pass");
  for (const extra of [[], ["--manifest", p.mf], ["--gx", path.join(GX("routed"), "gx")]]) {
    const r = run(["--repo", both, ...extra]);
    assert.equal(r.status, 1, `${extra.join(" ")}: ${r.out}`);
    assert.match(r.out, /configures both Elementary \(packages\.yml\) and GX \(requirements\.txt\)/);
  }
  const r = run([...p.args, "--gx", path.join(GX("routed"), "gx")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /both --manifest \(Elementary\) and --gx \(GX\) were given/);
  // a GX context in the repo, checked as Elementary: still both
  const e = run(["--repo", GX("routed"), "--manifest", p.mf]);
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

// review finding 4: GX pulled in by the Airflow provider, from requirements/prod.txt, or in a Dockerfile
test("monitors: GX installed through the Airflow provider, a requirements folder or a Dockerfile is found", () => {
  for (const [file, text] of [
    ["requirements.txt", "apache-airflow-providers-great-expectations==4.1.0\n"],
    ["requirements/prod.txt", "great_expectations==1.24.1\n"],
    ["Dockerfile", "FROM python:3.12-slim\nRUN pip install great_expectations==1.24.1\n"],
    ["docker/worker.Dockerfile", "RUN pip install 'great-expectations[postgresql]'\n"],
  ]) {
    const d = tmp();
    fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n    version: 0.26.1\n");
    fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
    fs.writeFileSync(path.join(d, file), text);
    const r = run(["--repo", d]);
    assert.equal(r.status, 1, `${file}: ${r.out}`);
    assert.match(r.out, new RegExp(`and GX \\(${file.replace(/[.]/g, "\\.")}\\)`), file);
  }
});

test("monitors: Elementary configured with no manifest is NOT CHECKED, never a pass", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n    version: 0.26.1\n");
  const r = run(["--repo", d]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /NOT CHECKED: Elementary is configured; pass --manifest/);
});

// review finding 5: nothing from the repository can start a workflow command in the Actions log
test("monitors: a path holding a newline and :: does not reach the log as a workflow command", { skip: !posix && "a newline in a file name needs a POSIX file system" }, () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "packages.yml"), "packages:\n  - package: elementary-data/elementary\n");
  const evil = path.join(d, "x\n::warning title=injected::owned");
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, "great_expectations.yml"), "config_version: 4\n");
  const r = run(["--repo", d]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /configures both/);
  for (const line of r.out.split("\n")) assert.doesNotMatch(line, /^\s*::/, `a log line starts a workflow command: ${line}`);
  assert.equal(q("a\nb\r::c"), "a\\u000ab\\u000d::c");
});

test("monitors: bad input exits 2", () => {
  const notManifest = path.join(tmp(), "m.json");
  fs.writeFileSync(notManifest, JSON.stringify({ nodes: {} }));
  const p = el("pass");
  for (const [args, msg] of [
    [["--manfest", p.mf], /unknown flag: --manfest/],
    [["--manifest"], /--manifest needs a value/],
    [["--gx-python"], /--gx-python needs a value/],
    [["--repo", path.join(tmp(), "nope"), "--manifest", p.mf], /--repo .*: no such directory/],
    [["--repo", p.d, "--manifest", path.join(tmp(), "missing.json")], /no such file/],
    [["--repo", p.d, "--manifest", notManifest], /not a dbt manifest/],
    [["--repo", GX("routed"), "--gx", path.join(tmp(), "nope")], /--gx .*: no such directory/],
    [["stray"], /unexpected argument: stray/],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, msg, args.join(" "));
  }
});
