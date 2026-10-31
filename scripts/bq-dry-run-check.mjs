#!/usr/bin/env node
// Dry-runs compiled dbt models on BigQuery and fails any model that would process more bytes than its
// budget. A dry run is free and runs nothing; it returns the bytes the query would process.
//
//   node bq-dry-run-check.mjs --budgets <warehouse-budgets.yml> --compiled-dir <target/compiled> \
//     --manifest <target/manifest.json> --models "<name> <name> ..." --project <job project id> [--location <US>]
//
// The access token comes from BQ_ACCESS_TOKEN (in CI, google-github-actions/auth with
// token_format: access_token). It is sent only to bigquery.googleapis.com and never printed.
//
// Budget file (bytes, or a number with a unit: B, KB, MB, GB, TB, KiB, MiB, GiB, TiB):
//
//   default: 10 GiB
//   models:
//     fct_orders: 50 GiB
//   accept_unmeasured:
//     fct_events: incremental; the MERGE target scan was reviewed by hand
//
// A model with no entry uses `default`; with neither, it fails.
//
// What is measured: the model's compiled SELECT and nothing else. A model the gate cannot measure fails
// as NOT MEASURED (exit 3) rather than passing at a low number:
//   - an estimate BigQuery marks LOWER_BOUND (an external or federated table reports 0 bytes), or one
//     with no accuracy; only PRECISE and UPPER_BOUND are accepted
//   - SQL BigQuery reads as a SCRIPT (EXECUTE IMMEDIATE, several statements), whose dry run does not
//     count the work the script would do
//   - a model with pre_hook or post_hook SQL, or a sql_header: neither is in the compiled file
//   - an incremental model: its MERGE also scans the target table, which the compiled SELECT omits
// The last two can be accepted per model under `accept_unmeasured:` with a reason. The gate then
// measures the SELECT, prints the reason, and does not count the rest.
//
// Exit codes, all fail closed:
//   0 every model within budget (or no models)   1 a model over budget
//   2 usage or budget-file error                 3 a model could not be found or measured
//
// Node >= 20, no dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };

export class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseBytes(raw, where) {
  const m = String(raw).trim().replace(/^["']|["']$/g, "").match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/i);
  const unit = m && (m[2] || "b").toLowerCase();
  if (!m || !(unit in UNITS)) throw new Fail(2, `${where}: "${raw}" is not a byte count (use bytes or a number with B, KB, MB, GB, TB, KiB, MiB, GiB or TiB)`);
  const n = Math.floor(Number(m[1]) * UNITS[unit]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Fail(2, `${where}: "${raw}" must be a positive byte count`);
  return n;
}

// The budget file's shape is fixed and small, so it is read line by line rather than with a YAML
// library. Anything outside that shape is an error, never skipped.
export function parseBudgets(text) {
  const out = { default: undefined, models: {}, accept: {} };
  let section = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const where = `line ${i + 1}`;
    const body = line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!body.trim()) return;
    let m;
    if ((m = body.match(/^default:\s*(.+)$/))) { out.default = parseBytes(m[1], where); section = null; return; }
    if (/^models:\s*$/.test(body)) { section = "models"; return; }
    if (/^accept_unmeasured:\s*$/.test(body)) { section = "accept"; return; }
    if (section && (m = body.match(/^\s+([A-Za-z0-9_.-]+):\s*(.+)$/))) {
      if (m[1] in out[section]) throw new Fail(2, `${where}: model ${m[1]} is listed twice`);
      out[section][m[1]] = section === "models" ? parseBytes(m[2], where) : m[2].trim();
      return;
    }
    throw new Fail(2, `${where}: not understood: ${body.trim()}`);
  });
  return out;
}

export function findCompiled(dir, model) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${model}.sql`) hits.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  if (hits.length !== 1) throw new Fail(3, `${model}: ${hits.length ? `${hits.length} compiled files named ${model}.sql` : "no compiled file"} under ${dir}`);
  return hits[0];
}

export async function dryRun({ sql, project, location, token, fetchImpl = fetch }) {
  const body = { configuration: { dryRun: true, query: { query: sql, useLegacySql: false, useQueryCache: false } } };
  if (location) body.jobReference = { projectId: project, location };
  const res = await fetchImpl(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Fail(3, `dry run failed: HTTP ${res.status}: ${String(json?.error?.message ?? "").slice(0, 300)}`);
  const q = json?.statistics?.query ?? {};
  const bytes = Number(q.totalBytesProcessed ?? json?.statistics?.totalBytesProcessed);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Fail(3, "dry run returned no totalBytesProcessed");
  if (q.statementType === "SCRIPT") throw new Fail(3, "NOT MEASURED: BigQuery reads this SQL as a script (EXECUTE IMMEDIATE or several statements), and a script's dry run does not count the work it would do");
  const accuracy = q.totalBytesProcessedAccuracy;
  if (accuracy !== "PRECISE" && accuracy !== "UPPER_BOUND") throw new Fail(3, `NOT MEASURED: the estimate is ${accuracy ?? "of unknown accuracy"}, not PRECISE or UPPER_BOUND (an external or federated table reports a lower bound), so the budget cannot be checked`);
  return bytes;
}

// The parts of a model's run that its compiled SELECT does not contain, read from target/manifest.json.
export function unmeasuredParts(manifest, model) {
  const nodes = Object.values(manifest?.nodes ?? {}).filter((n) => n.resource_type === "model" && n.name === model);
  if (nodes.length !== 1) throw new Fail(3, `${model}: ${nodes.length ? `${nodes.length} models` : "no model"} of that name in the manifest`);
  const c = nodes[0].config ?? {};
  const hooks = (h) => (Array.isArray(h) ? h : h ? [h] : []).filter((x) => String(x?.sql ?? x).trim());
  const parts = [];
  if (hooks(c.pre_hook ?? c["pre-hook"]).length) parts.push("pre_hook");
  if (hooks(c.post_hook ?? c["post-hook"]).length) parts.push("post_hook");
  if (String(c.sql_header ?? "").trim()) parts.push("sql_header");
  if (c.materialized === "incremental") parts.push("incremental MERGE target scan");
  return parts;
}

export async function check({ budgetsText, compiledDir, manifest, models, project, location, token, fetchImpl, log = console.log }) {
  if (!project) throw new Fail(2, "--project is required");
  const budgets = parseBudgets(budgetsText);
  if (!models.length) { log("bq-dry-run: no models to check"); return 0; }
  if (!manifest) throw new Fail(2, "the dbt manifest is required");
  if (!token) throw new Fail(2, "BQ_ACCESS_TOKEN is not set");
  let over = 0;
  for (const model of models) {
    const budget = budgets.models[model] ?? budgets.default;
    if (budget === undefined) throw new Fail(2, `${model}: no budget and no default in the budget file`);
    const parts = unmeasuredParts(manifest, model);
    if (parts.length && !budgets.accept[model]) throw new Fail(3, `NOT MEASURED ${model}: its ${parts.join(", ")} is not in the compiled SELECT; list the model under accept_unmeasured with a reason to measure only the SELECT`);
    if (parts.length) log(`note ${model}: ${parts.join(", ")} not measured (accepted: ${budgets.accept[model]})`);
    const sql = fs.readFileSync(findCompiled(compiledDir, model), "utf8");
    let bytes;
    try {
      bytes = await dryRun({ sql, project, location, token, fetchImpl });
    } catch (e) {
      if (e instanceof Fail) e.message = `${model}: ${e.message}`;
      throw e;
    }
    const ok = bytes <= budget;
    if (!ok) over++;
    log(`${ok ? "ok  " : "OVER"} ${model}: ${bytes} bytes processed, budget ${budget}`);
  }
  if (over) log(`bq-dry-run: ${over} model(s) over budget`);
  return over ? 1 : 0;
}

export async function main(argv, env = process.env) {
  const known = new Set(["--budgets", "--compiled-dir", "--manifest", "--models", "--project", "--location"]);
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) throw new Fail(2, `usage: bq-dry-run-check.mjs --budgets <file> --compiled-dir <dir> --manifest <file> --models "<a b>" --project <id> [--location <loc>]; bad argument ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.budgets || !opts["compiled-dir"] || !opts.manifest || opts.models === undefined) throw new Fail(2, "--budgets, --compiled-dir, --manifest and --models are required");
  if (!fs.existsSync(opts.budgets)) throw new Fail(2, `budget file ${opts.budgets} does not exist`);
  const models = opts.models.split(/\s+/).filter(Boolean);
  let manifest;
  if (models.length) {
    try {
      manifest = JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
    } catch (e) {
      throw new Fail(2, `manifest ${opts.manifest}: ${e.message}`);
    }
  }
  return check({
    budgetsText: fs.readFileSync(opts.budgets, "utf8"),
    compiledDir: opts["compiled-dir"],
    manifest,
    models,
    project: opts.project,
    location: opts.location,
    token: env.BQ_ACCESS_TOKEN,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(`bq-dry-run: ${e.message}`); process.exit(e instanceof Fail ? e.code : 3); },
  );
}
