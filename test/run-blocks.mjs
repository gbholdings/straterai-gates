#!/usr/bin/env node
// Runs the `run:` blocks of the reusable workflows against fixtures and asserts the exit code.
//
// For each fixture case under test/fixtures/<dir>/<case>/ it builds a temp git repo: `base/` becomes
// origin/main, `head/` becomes the PR branch on top. Then it runs the gate's named steps, in order, with
// `bash -e -o pipefail` as GitHub does, using the workflow's own env and input defaults. Each step's `if:` is
// evaluated as GitHub would (success() by default, so a failed step skips the rest unless their `if:`
// says otherwise), each step gets its own GITHUB_OUTPUT, and GITHUB_ENV carries into later steps. Every
// case gets its own RUNNER_TEMP, and the repo gets this checkout's scripts/ under .gates/, as the
// workflows' "Check out the gates" step does.
//
// A case may carry:
//   expect          the job result: 0 passes, anything else fails (any nonzero step)
//   inputs.json     input overrides
//   event.json      { "event_name": ..., "pr_number": ... } (default pull_request, 7)
//   links           lines of "<path> <target>" committed as symlinks in head
//   expect-output   lines that must appear in some step's GITHUB_OUTPUT
//   expect-log      lines that must each appear in the log, so a failing case fails for its stated reason
//   expect-gh       lines that must each appear in the fake `gh` log (its argv, and any -F body=@file)
//   secrets.json    secrets the workflow sees (default none)
//   expect-evidence lines that must each appear in the datacontract evidence file
//   gh-responses    lines of "<argv substring>\t<stdout>" the fake `gh` answers with (first match wins)
//
// Expressions are resolved the narrow way these workflows use them; anything else throws.
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
    steps: ["Lint changed migrations"],
    inputs: { config_path: fwd(path.join(FIX, "squawk", "squawk.toml")) },
  },
  {
    name: "datacontract",
    workflow: "datacontract.yml",
    fixtures: "datacontract",
    jobs: {
      contracts: [
        "Check the inputs",
        "Build the fixture repository",
        "Did a contract change?",
        "Lint every contract",
        "Contracts match the schema",
        "Every contract has an owner",
        "Breaking changes, deletions and retirements",
        "Record evidence",
      ],
      notice: ["Tell the consumers"],
    },
    handoff: "datacontract-breaking",
    inputs: {},
    gates: true,
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

// ---------------------------------------------------------------------------------------------------
// GitHub expressions, the subset these workflows use: literals ('x', true, false, numbers), context
// paths (inputs.*, steps.<id>.outputs.<k>, steps.<id>.outcome, github.*, env.*, secrets.*, job.*,
// runner.*), ==, !=, !, &&, ||, parentheses, and the status functions. && and || return an operand,
// as GitHub's do. Equality is loose the way GitHub's is for these types: '' == false, 'true' != true.

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, s = "";
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string in: ${src}`);
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
      }
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "&&", "||"].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
    if ("!()".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_.-]*|^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`cannot read expression at "${src.slice(i)}"`);
    toks.push({ t: "id", v: m[0] });
    i += m[0].length;
  }
  return toks;
}

function evaluate(src, ctx) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => {
    const t = toks[p];
    if (!t || t.v !== v) throw new Error(`expected ${v} in: ${src}`);
    p++;
  };
  const truthy = (v) => !(v === false || v === null || v === undefined || v === "" || v === 0);
  const eq = (a, b) => {
    if (typeof a === typeof b) return a === b;
    const num = (x) => (x === true ? 1 : x === false || x === null || x === "" ? 0 : Number(x));
    return num(a) === num(b);
  };
  function primary() {
    const t = peek();
    if (!t) throw new Error(`unexpected end of: ${src}`);
    if (t.v === "(") { p++; const v = or(); eat(")"); return v; }
    if (t.v === "!") { p++; return !truthy(primary()); }
    p++;
    if (t.t === "str") return t.v;
    if (t.v === "true") return true;
    if (t.v === "false") return false;
    if (t.v === "null") return null;
    if (/^\d/.test(t.v)) return Number(t.v);
    if (peek()?.v === "(") {
      eat("(");
      eat(")");
      if (!(t.v in ctx.fns)) throw new Error(`unsupported function ${t.v}() in: ${src}`);
      return ctx.fns[t.v]();
    }
    return ctx.lookup(t.v, src);
  }
  function cmp() {
    let v = primary();
    while (peek() && (peek().v === "==" || peek().v === "!=")) {
      const op = toks[p++].v;
      const r = primary();
      v = op === "==" ? eq(v, r) : !eq(v, r);
    }
    return v;
  }
  function and() {
    let v = cmp();
    while (peek()?.v === "&&") { p++; const r = cmp(); v = truthy(v) ? r : v; }
    return v;
  }
  function or() {
    let v = and();
    while (peek()?.v === "||") { p++; const r = and(); v = truthy(v) ? v : r; }
    return v;
  }
  const v = or();
  if (p !== toks.length) throw new Error(`trailing tokens in: ${src}`);
  return { value: v, truthy: truthy(v), usesStatus: toks.some((t, i) => t.t === "id" && ["always", "failure", "cancelled", "success"].includes(t.v) && toks[i + 1]?.v === "(") };
}

function makeLookup(inputs, ctx) {
  return (name, src) => {
    const parts = name.split(".");
    switch (parts[0]) {
      case "inputs":
        return inputs[parts[1]] ?? "";
      case "steps": {
        const s = ctx.steps[parts[1]];
        if (!s) return "";
        if (parts[2] === "outcome" || parts[2] === "conclusion") return s.outcome;
        if (parts[2] === "outputs") return s.outputs[parts[3]] ?? "";
        break;
      }
      case "github":
        if (parts[1] === "base_ref") return "main";
        if (parts[1] === "event_name") return ctx.event.event_name;
        if (parts[1] === "repository") return "example-org/gates-under-test";
        if (parts[1] === "workspace") return fwd(ctx.repo);
        if (parts[1] === "server_url") return "https://github.example.test";
        if (parts[1] === "run_id") return "4242";
        if (parts[1] === "sha") return "fake-head-sha";
        if (parts[1] === "token") return "fake-token";
        if (parts[1] === "event" && parts[2] === "pull_request" && parts[3] === "number") return String(ctx.event.pr_number);
        if (parts[1] === "event") return "";
        return "";
      case "env":
        return ctx.env[parts[1]] ?? "";
      case "needs": {
        const n = ctx.needs?.[parts[1]];
        if (!n) return "";
        if (parts[2] === "result") return n.result;
        if (parts[2] === "outputs") return n.outputs[parts[3]] ?? "";
        return "";
      }
      case "secrets":
        return ctx.secrets[parts[1]] ?? "";
      case "runner":
        return parts[1] === "temp" ? fwd(ctx.runnerTemp ?? "") : "";
      case "vars":
      case "job":
        return "";
    }
    throw new Error(`unsupported expression: ${name} in: ${src}`);
  };
}

// ${{ expr }} inside a string, as in env: values and with: inputs.
function interpolate(value, lookupCtx) {
  if (typeof value !== "string") return String(value);
  return value.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr) => {
    const v = evaluate(expr, lookupCtx).value;
    return v === null || v === undefined ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------------------------------

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function copyTree(from, to) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

function buildRepo(caseDir, work) {
  const repo = path.join(work, "repo");
  fs.mkdirSync(repo);
  const git = (...a) => sh("git", a, repo, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  copyTree(path.join(caseDir, "base"), repo);
  // base-rename: [{ from, to }] renames a base file to a name a Windows checkout cannot hold (a newline,
  // `<`, a backtick), so a case can carry a hostile path without the repository carrying one.
  const renames = path.join(caseDir, "base-rename.json");
  if (fs.existsSync(renames)) for (const { from, to } of JSON.parse(fs.readFileSync(renames, "utf8"))) fs.renameSync(path.join(repo, from), path.join(repo, to));
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

// A stand-in for the GitHub CLI: logs its argv (and the file behind any -F body=@file) and prints the
// first canned response whose key is a substring of its argv, or nothing.
function fakeGh(work, caseDir) {
  const bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  const log = path.join(work, "gh.log");
  const responses = path.join(caseDir, "gh-responses");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
let out = "gh " + argv.join(" ") + "\\n";
for (const a of argv) { const m = /^body=@(.*)$/.exec(a); if (m) out += fs.readFileSync(m[1], "utf8") + "\\n"; }
const bf = argv.indexOf("--body-file"); if (bf >= 0) out += fs.readFileSync(argv[bf + 1], "utf8") + "\\n";
fs.appendFileSync(${JSON.stringify(fwd(log))}, out);
const r = ${JSON.stringify(fwd(responses))};
if (fs.existsSync(r)) {
  for (const line of fs.readFileSync(r, "utf8").split("\\n").filter(Boolean)) {
    const [key, ...rest] = line.split("\\t");
    if (argv.join(" ").includes(key)) { process.stdout.write(rest.join("\\t").replace(/\\\\n/g, "\\n") + "\\n"); break; }
  }
}
`;
  fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
  fs.writeFileSync(log, "");
  return { bin, log };
}

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean) : [];
}

function runCase(gate, wf, caseName) {
  const caseDir = path.join(FIX, gate.fixtures, caseName);
  const inputs = { ...wf.inputs, ...gate.inputs };
  const overrides = path.join(caseDir, "inputs.json");
  if (fs.existsSync(overrides)) Object.assign(inputs, JSON.parse(fs.readFileSync(overrides, "utf8")));
  const eventFile = path.join(caseDir, "event.json");
  const event = { event_name: "pull_request", pr_number: 7, ...(fs.existsSync(eventFile) ? JSON.parse(fs.readFileSync(eventFile, "utf8")) : {}) };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "blocks-"));
  const repo = buildRepo(caseDir, work);
  const gh = fakeGh(work, caseDir);

  const secretsFile = path.join(caseDir, "secrets.json");
  const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, "utf8")) : {};
  // A gate names the steps to run per job; one with `steps` runs those of the workflow's first job.
  const plan = gate.jobs ?? { [Object.keys(wf.jobs)[0]]: gate.steps };
  const needs = {};
  let code = 0;
  let log = "";
  let outputs = "";
  let first = true;
  let firstTemp = null;
  for (const [jobName, stepNames] of Object.entries(plan)) {
    const job = wf.jobs[jobName];
    if (!job) throw new Error(`${gate.workflow} has no job ${jobName}`);
    // The first job runs in the PR's checkout. A later job gets an empty workspace (it checks out only
    // the gates) and its own runner temp, into which the handed-over folder is copied, as an artifact is.
    const workspace = first ? repo : fs.mkdtempSync(path.join(work, `ws-${jobName}-`));
    const runnerTemp = fs.mkdtempSync(path.join(work, `runner-temp-${jobName}-`));
    if (first) firstTemp = runnerTemp;
    else if (gate.handoff && fs.existsSync(path.join(firstTemp, gate.handoff))) fs.cpSync(path.join(firstTemp, gate.handoff), path.join(runnerTemp, gate.handoff), { recursive: true });
    if (gate.gates) fs.cpSync(path.join(ROOT, "scripts"), path.join(workspace, ".gates", "scripts"), { recursive: true });
    if (gate.gates && fs.existsSync(path.join(ROOT, "requirements"))) fs.cpSync(path.join(ROOT, "requirements"), path.join(workspace, ".gates", "requirements"), { recursive: true });
    const ctx = { steps: {}, event, repo: workspace, runnerTemp, env: {}, secrets, needs };
    let failed = false;
    const needFailed = () => job.needs.some((n) => needs[n]?.result === "failure");
    ctx.fns = { success: () => !failed && !needFailed(), failure: () => failed || needFailed(), always: () => true, cancelled: () => false };
    const exprCtx = { fns: ctx.fns, lookup: makeLookup(inputs, ctx) };
    if (job.if) {
      const cond = String(job.if).replace(/^\s*\$\{\{\s*/, "").replace(/\s*\}\}\s*$/, "");
      const r = evaluate(cond, exprCtx);
      const run = r.usesStatus ? r.truthy : !needFailed() && r.truthy;
      if (!run) {
        log += `=== job ${jobName} (skipped)\n`;
        needs[jobName] = { result: "skipped", outputs: {} };
        first = false;
        continue;
      }
    }
    log += `=== job ${jobName}\n`;
    const jobEnv = {};
    for (const [k, v] of Object.entries(job.env)) jobEnv[k] = interpolate(v, exprCtx);
    ctx.env = { ...jobEnv };
    // pre-env: GITHUB_ENV lines an earlier step of the first job is taken to have written ({repo} is the
    // checkout), so a case can prove a planted BASH_ENV is never sourced.
    const carried = {};
    if (first) for (const l of lines(path.join(caseDir, "pre-env"))) {
      const eq = l.indexOf("=");
      carried[l.slice(0, eq)] = l.slice(eq + 1).replaceAll("{repo}", fwd(repo));
    }
    const summary = path.join(work, `${jobName}.summary`);
    fs.writeFileSync(summary, "");
    job.steps.forEach((step, i) => {
      if (!step.run || !stepNames.includes(step.name)) return;
      const id = step.id ?? `__step${i}`;
      let run;
      if (step.if) {
        const cond = String(step.if).replace(/^\s*\$\{\{\s*/, "").replace(/\s*\}\}\s*$/, "");
        const r = evaluate(cond, exprCtx);
        run = r.usesStatus ? r.truthy : !failed && r.truthy;
      } else run = !failed;
      if (!run) {
        ctx.steps[id] = { outcome: "skipped", outputs: {} };
        log += `--- ${step.name} (skipped)\n`;
        return;
      }
      const out = path.join(work, `${jobName}-${id}.out`);
      const envFile = path.join(work, `${jobName}-${id}.env`);
      fs.writeFileSync(out, "");
      fs.writeFileSync(envFile, "");
      const env = { ...jobEnv, ...carried, GITHUB_OUTPUT: fwd(out), GITHUB_ENV: fwd(envFile), GITHUB_STEP_SUMMARY: fwd(summary), RUNNER_TEMP: fwd(runnerTemp), GITHUB_WORKSPACE: fwd(workspace), PATH: `${gh.bin}${path.delimiter}${process.env.PATH}` };
      ctx.env = env;
      for (const [k, v] of Object.entries(step.env)) env[k] = interpolate(v, exprCtx);
      const script = path.join(work, `${jobName}-${id}.sh`);
      fs.writeFileSync(script, step.run);
      // The step's shell, else the job's default, else GitHub's bash; {0} is the script.
      const shell = (step.shell ?? job.shell ?? "bash -e -o pipefail {0}").trim().split(/\s+/).map((a) => (a === "{0}" ? fwd(script) : a));
      const r = spawnSync(shell[0], shell.slice(1), { cwd: workspace, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300000 });
      log += `--- ${step.name} (exit ${r.status})\n${r.stdout}${r.stderr}`;
      const stepOutputs = {};
      for (const l of lines(out)) {
        const eq = l.indexOf("=");
        if (eq > 0) stepOutputs[l.slice(0, eq)] = l.slice(eq + 1);
      }
      outputs += fs.readFileSync(out, "utf8");
      for (const l of lines(envFile)) {
        const eq = l.indexOf("=");
        if (eq > 0) carried[l.slice(0, eq)] = l.slice(eq + 1);
      }
      ctx.steps[id] = { outcome: r.status === 0 ? "success" : "failure", outputs: stepOutputs };
      if (r.status !== 0) {
        failed = true;
        if (!code) code = r.status ?? 1;
      }
    });
    const s = fs.readFileSync(summary, "utf8");
    if (s) log += `--- step summary\n${s}`;
    const jobOutputs = {};
    for (const [k, v] of Object.entries(job.outputs)) jobOutputs[k] = interpolate(v, exprCtx);
    needs[jobName] = { result: failed ? "failure" : "success", outputs: jobOutputs };
    first = false;
  }
  const runnerTemp = firstTemp;
  let expectOk = true;
  const want = (file, haystack, what) => {
    const missing = lines(path.join(caseDir, file)).filter((l) => !haystack.includes(l));
    if (missing.length) {
      expectOk = false;
      log += `--- expected ${what} to contain:\n${missing.join("\n")}\n`;
    }
  };
  want("expect-output", outputs.split("\n").map((l) => `${l}\n`).join(""), "a step's GITHUB_OUTPUT");
  want("expect-log", log, "the log");
  const ghLog = fs.readFileSync(gh.log, "utf8");
  want("expect-gh", ghLog, "the gh calls");
  // reject-log and reject-gh: lines that must appear nowhere (a planted script's marker, a token value).
  const reject = (file, haystack, what) => {
    const found = lines(path.join(caseDir, file)).filter((l) => haystack.includes(l));
    if (found.length) {
      expectOk = false;
      log += `--- expected ${what} NOT to contain:\n${found.join("\n")}\n`;
    }
  };
  reject("reject-log", log + ghLog, "the log or the gh calls");
  reject("reject-gh", ghLog, "the gh calls");
  // A case that expects no gh call gets none: a notice on a passing PR is a bug.
  if (!fs.existsSync(path.join(caseDir, "expect-gh")) && ghLog) {
    expectOk = false;
    log += `--- expected no gh calls, got:
${ghLog}`;
  }
  if (fs.existsSync(path.join(caseDir, "expect-gh"))) log += `--- gh calls\n${ghLog}`;
  const evidence = path.join(runnerTemp, "datacontract-evidence", "evidence.json");
  if (fs.existsSync(evidence)) log += `--- evidence\n${fs.readFileSync(evidence, "utf8")}`;
  want("expect-evidence", fs.existsSync(evidence) ? fs.readFileSync(evidence, "utf8") : "", "the evidence file");
  fs.rmSync(work, { recursive: true, force: true });
  return { code, expectOk, log };
}

let failedCases = 0;
const only = process.argv[2];
const verbose = process.argv.includes("--verbose");
for (const gate of GATES) {
  if (only && only !== "--verbose" && !gate.name.startsWith(only)) continue;
  const wf = load(gate.workflow);
  for (const caseName of fs.readdirSync(path.join(FIX, gate.fixtures)).sort()) {
    if (!fs.statSync(path.join(FIX, gate.fixtures, caseName)).isDirectory()) continue;
    const want = Number(fs.readFileSync(path.join(FIX, gate.fixtures, caseName, "expect"), "utf8").trim());
    const r = runCase(gate, wf, caseName);
    // Exit codes compare as pass or fail; expect-log pins down why a failing case failed.
    const ok = (want === 0 ? r.code === 0 : r.code !== 0) && r.expectOk;
    console.log(`${ok ? "ok  " : "FAIL"} ${gate.name} / ${caseName} (want ${want}, got ${r.code})`);
    if (!ok || verbose) {
      if (!ok) failedCases++;
      console.log(r.log);
    }
  }
}
if (failedCases) {
  console.log(`${failedCases} fixture case(s) failed`);
  process.exit(1);
}
