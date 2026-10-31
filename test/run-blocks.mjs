#!/usr/bin/env node
// Runs the `run:` blocks of the reusable workflows against fixtures and asserts the exit code.
//
// For each fixture case under test/fixtures/<dir>/<case>/ it builds a temp git repo: `base/` becomes
// origin/main, `head/` becomes the PR branch on top. Then it runs the gate's named steps, in order, with
// `bash -e -o pipefail` as GitHub does, using the workflow's own env and input defaults. The first nonzero step stops
// the case, as on a runner. A case may carry `inputs.json` (input overrides), `links` (lines of
// "<path> <target>" committed as symlinks in head) and `expect-output` (lines that must appear in
// $GITHUB_OUTPUT), `expect-log` (lines that must appear in the steps' output, so a failing case proves which
// check failed it), `event.json` (the pull request the event carries: {"number", "author", "repository"}) and
// `reviews.json` (what `gh api graphql` returns for that pull request; "HEAD" in it becomes the head commit's
// SHA). With reviews.json, test/bin goes first on PATH, so the gate's `gh` prints that file. Lines a step
// appends to $GITHUB_ENV are in the environment of the steps after it, as on a runner.
//
// Expressions are resolved the narrow way these workflows use them: inputs.<name>, github.base_ref and
// github.event.pull_request.base.ref (main here), github.event.pull_request.head.sha (the head commit), the
// event.json fields, and nothing else (vars.*, secrets.* and other github.* are empty).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test", "fixtures");
const fwd = (p) => p.replace(/\\/g, "/");

const GATES = [
  {
    name: "squawk",
    workflow: "squawk.yml",
    fixtures: "squawk",
    steps: ["Install the SQL parser", "Install squawk", "Destructive change needs an approving review", "Lint changed migrations"],
    inputs: { config_path: fwd(path.join(FIX, "squawk", "squawk.toml")) },
  },
  {
    name: "datacontract",
    workflow: "datacontract.yml",
    fixtures: "datacontract",
    steps: ["Did a contract change?", "Lint every contract", "Breaking changes, deletions and retirements"],
    inputs: {},
  },
  {
    name: "dbt (change detection)",
    workflow: "dbt.yml",
    fixtures: "dbt-changes",
    steps: ["Did a dbt file change?"],
    inputs: {},
  },
  {
    name: "bq-dry-run (change detection)",
    workflow: "bq-dry-run.yml",
    fixtures: "bq-dry-run-changes",
    steps: ["What changed?"],
    inputs: {},
  },
  {
    name: "bq-dry-run (CI profile cap)",
    workflow: "bq-dry-run.yml",
    fixtures: "bq-dry-run-profile",
    steps: ["What changed?", "Check the CI profile caps billed bytes"],
    inputs: {},
  },
];

function pythonBin() {
  for (const c of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const r = spawnSync(c, ["-c", "import yaml"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  throw new Error("need python with PyYAML (set PYTHON to it)");
}

function load(workflow) {
  const r = spawnSync(pythonBin(), [path.join(ROOT, "test", "extract-workflow.py"), path.join(ROOT, ".github", "workflows", workflow)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot read ${workflow}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function resolve(value, inputs, ctx = {}) {
  if (typeof value !== "string") return String(value);
  return value.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr) => {
    let m;
    if ((m = /^inputs\.(\w+)$/.exec(expr))) return String(inputs[m[1]] ?? "");
    if (expr === "github.base_ref" || expr === "github.event.pull_request.base.ref") return "main";
    if (expr === "github.event.pull_request.head.sha") return ctx.head ?? "";
    if (expr === "github.event.pull_request.number") return String(ctx.event?.number ?? "");
    if (expr === "github.event.pull_request.user.login") return ctx.event?.author ?? "";
    if (expr === "github.repository") return ctx.event?.repository ?? "";
    if (/^(vars|secrets|github)\./.test(expr)) return "";
    // A composite such as "squawk-cli@${{ inputs.x }}" is handled by the outer replace; anything else is unsupported.
    throw new Error(`unsupported expression: ${expr}`);
  });
}

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function copyTree(from, to) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

function buildRepo(caseDir) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "blocks-"));
  const git = (...a) => sh("git", a, repo, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  copyTree(path.join(caseDir, "base"), repo);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "pr");
  for (const e of fs.readdirSync(repo)) if (e !== ".git") fs.rmSync(path.join(repo, e), { recursive: true, force: true });
  copyTree(path.join(caseDir, "head"), repo);
  git("add", "-A");
  const links = path.join(caseDir, "links");
  if (fs.existsSync(links)) {
    for (const line of fs.readFileSync(links, "utf8").split("\n").filter(Boolean)) {
      const [p, target] = line.split(" ");
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: target, encoding: "utf8" }).stdout.trim();
      git("update-index", "--add", "--cacheinfo", `120000,${blob},${p}`);
    }
  }
  git("commit", "-q", "--allow-empty", "-m", "head");
  return repo;
}

function runCase(gate, wf, caseName) {
  const caseDir = path.join(FIX, gate.fixtures, caseName);
  const inputs = { ...wf.inputs, ...gate.inputs };
  const overrides = path.join(caseDir, "inputs.json");
  if (fs.existsSync(overrides)) Object.assign(inputs, JSON.parse(fs.readFileSync(overrides, "utf8")));
  const repo = buildRepo(caseDir);
  const out = path.join(repo, "..", `${path.basename(repo)}.out`);
  fs.writeFileSync(out, "");
  const envFile = path.join(repo, "..", `${path.basename(repo)}.env`);
  fs.writeFileSync(envFile, "");
  const read = (f) => (fs.existsSync(path.join(caseDir, f)) ? fs.readFileSync(path.join(caseDir, f), "utf8") : null);
  const ctx = { head: sh("git", ["rev-parse", "HEAD"], repo, {}).trim(), event: JSON.parse(read("event.json") ?? "null") };
  const extra = {};
  const reviews = read("reviews.json");
  if (reviews !== null) {
    const f = path.join(repo, "..", `${path.basename(repo)}.reviews.json`);
    fs.writeFileSync(f, reviews.replaceAll("HEAD", ctx.head));
    extra.GH_STUB_REVIEWS = fwd(f);
    extra.PATH = `${path.join(ROOT, "test", "bin")}${path.delimiter}${process.env.PATH}`;
  }
  const baseEnv = {};
  for (const [k, v] of Object.entries(wf.env)) baseEnv[k] = resolve(v, inputs, ctx);
  let code = 0;
  let log = "";
  for (const step of wf.steps) {
    if (!step.run || !gate.steps.includes(step.name)) continue;
    const output = fs.readFileSync(out, "utf8");
    if (step.if) {
      if (step.if.includes("steps.changes.outputs.changed == 'true'") && !output.includes("changed=true")) continue;
      if (step.if.includes("inputs.lint_all != true") && String(inputs.lint_all) === "true") continue;
    }
    const added = {};
    for (const l of fs.readFileSync(envFile, "utf8").split("\n")) if (l.includes("=")) added[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1);
    const env = { ...baseEnv, ...added, ...extra, GITHUB_OUTPUT: fwd(out), GITHUB_ENV: fwd(envFile), RUNNER_TEMP: fwd(os.tmpdir()) };
    for (const [k, v] of Object.entries(step.env)) env[k] = resolve(v, inputs, ctx);
    const script = path.join(repo, "..", `${path.basename(repo)}.sh`);
    fs.writeFileSync(script, step.run);
    const r = spawnSync("bash", ["-e", "-o", "pipefail", fwd(script)], { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300000 });
    log += `--- ${step.name} (exit ${r.status})\n${r.stdout}${r.stderr}`;
    if (r.status !== 0) {
      code = r.status ?? 1;
      break;
    }
  }
  const outputFile = path.join(caseDir, "expect-output");
  let outputOk = true;
  if (fs.existsSync(outputFile)) {
    const got = fs.readFileSync(out, "utf8");
    outputOk = fs.readFileSync(outputFile, "utf8").split("\n").filter(Boolean).every((l) => got.split("\n").includes(l));
    if (!outputOk) log += `--- expected GITHUB_OUTPUT to contain:\n${fs.readFileSync(outputFile, "utf8")}got:\n${got}\n`;
  }
  const logFile = path.join(caseDir, "expect-log");
  if (fs.existsSync(logFile)) {
    const missing = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).filter((l) => !log.includes(l));
    if (missing.length) {
      outputOk = false;
      log += `--- expected the log to contain:\n${missing.join("\n")}\n`;
    }
  }
  fs.rmSync(repo, { recursive: true, force: true });
  return { code, outputOk, log };
}

let failed = 0;
const only = process.argv[2];
for (const gate of GATES) {
  if (only && !gate.name.startsWith(only)) continue;
  const wf = load(gate.workflow);
  for (const caseName of fs.readdirSync(path.join(FIX, gate.fixtures)).sort()) {
    if (!fs.statSync(path.join(FIX, gate.fixtures, caseName)).isDirectory()) continue;
    const want = Number(fs.readFileSync(path.join(FIX, gate.fixtures, caseName, "expect"), "utf8").trim());
    const r = runCase(gate, wf, caseName);
    // Exit codes compare as pass or fail: a gate that fails may fail with any nonzero code.
    const ok = (want === 0 ? r.code === 0 : r.code !== 0) && r.outputOk;
    console.log(`${ok ? "ok  " : "FAIL"} ${gate.name} / ${caseName} (want ${want}, got ${r.code})`);
    if (!ok) {
      failed++;
      console.log(r.log);
    }
  }
}
if (failed) {
  console.log(`${failed} fixture case(s) failed`);
  process.exit(1);
}
