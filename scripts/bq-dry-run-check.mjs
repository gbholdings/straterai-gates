#!/usr/bin/env node
// Dry-runs compiled dbt models on BigQuery and fails any model that would process more bytes than its
// budget. A dry run is free and runs nothing; it returns the bytes the query would process.
//
//   node bq-dry-run-check.mjs --budgets <warehouse-budgets.yml> --compiled-dir <target/compiled> \
//     --models "<name> <name> ..." --project <job project id> [--location <US>]
//
// The access token comes from BQ_ACCESS_TOKEN (in CI, google-github-actions/auth with
// token_format: access_token). It is sent only to bigquery.googleapis.com and never printed.
//
// Budget file (bytes, or a number with a unit: B, KB, MB, GB, TB, KiB, MiB, GiB, TiB):
//
//   default: 10 GiB
//   models:
//     fct_orders: 50 GiB
//
// A model with no entry uses `default`; with neither, it fails. Exit codes, all fail closed:
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
  const out = { default: undefined, models: {} };
  let inModels = false;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const where = `line ${i + 1}`;
    const body = line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (!body.trim()) return;
    let m;
    if ((m = body.match(/^default:\s*(.+)$/))) { out.default = parseBytes(m[1], where); inModels = false; return; }
    if (/^models:\s*$/.test(body)) { inModels = true; return; }
    if (inModels && (m = body.match(/^\s+([A-Za-z0-9_.-]+):\s*(.+)$/))) {
      if (m[1] in out.models) throw new Fail(2, `${where}: model ${m[1]} is listed twice`);
      out.models[m[1]] = parseBytes(m[2], where);
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
  const bytes = Number(json?.statistics?.query?.totalBytesProcessed ?? json?.statistics?.totalBytesProcessed);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Fail(3, "dry run returned no totalBytesProcessed");
  return bytes;
}

export async function check({ budgetsText, compiledDir, models, project, location, token, fetchImpl, log = console.log }) {
  if (!project) throw new Fail(2, "--project is required");
  const budgets = parseBudgets(budgetsText);
  if (!models.length) { log("bq-dry-run: no changed models"); return 0; }
  if (!token) throw new Fail(2, "BQ_ACCESS_TOKEN is not set");
  let over = 0;
  for (const model of models) {
    const budget = budgets.models[model] ?? budgets.default;
    if (budget === undefined) throw new Fail(2, `${model}: no budget and no default in the budget file`);
    const sql = fs.readFileSync(findCompiled(compiledDir, model), "utf8");
    const bytes = await dryRun({ sql, project, location, token, fetchImpl });
    const ok = bytes <= budget;
    if (!ok) over++;
    log(`${ok ? "ok  " : "OVER"} ${model}: ${bytes} bytes processed, budget ${budget}`);
  }
  if (over) log(`bq-dry-run: ${over} model(s) over budget`);
  return over ? 1 : 0;
}

export async function main(argv, env = process.env) {
  const known = new Set(["--budgets", "--compiled-dir", "--models", "--project", "--location"]);
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) throw new Fail(2, `usage: bq-dry-run-check.mjs --budgets <file> --compiled-dir <dir> --models "<a b>" --project <id> [--location <loc>]; bad argument ${argv[i]}`);
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.budgets || !opts["compiled-dir"] || opts.models === undefined) throw new Fail(2, "--budgets, --compiled-dir and --models are required");
  if (!fs.existsSync(opts.budgets)) throw new Fail(2, `budget file ${opts.budgets} does not exist`);
  return check({
    budgetsText: fs.readFileSync(opts.budgets, "utf8"),
    compiledDir: opts["compiled-dir"],
    models: opts.models.split(/\s+/).filter(Boolean),
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
