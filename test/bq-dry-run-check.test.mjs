// Tests for scripts/bq-dry-run-check.mjs. The fetch to BigQuery is stubbed, except in the last test,
// which dry-runs the fixture models for real when BQ_ACCESS_TOKEN and BQ_LIVE_PROJECT are set.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, parseBudgets, parseBytes, dryRun, unmeasuredParts, main, Fail } from "../scripts/bq-dry-run-check.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bq-dry-run");
const COMPILED = path.join(FIX, "compiled");
const BUDGETS = fs.readFileSync(path.join(FIX, "warehouse-budgets.yml"), "utf8");
// The bytes BigQuery reported for the two fixture queries on 2026-10-30.
const MEASURED = { "select *": 6432064, "select word": 1332943 };
// What BigQuery returns for a plain table: the bytes, PRECISE, and the statement type.
const stub = (calls = [], extra = {}) => async (url, init) => {
  calls.push({ url, init });
  const sql = JSON.parse(init.body).configuration.query.query;
  const key = Object.keys(MEASURED).find((k) => sql.startsWith(k));
  return { ok: true, status: 200, json: async () => ({ statistics: { query: { totalBytesProcessed: String(MEASURED[key]), totalBytesProcessedAccuracy: "PRECISE", statementType: "SELECT", ...extra } } }) };
};
const quiet = () => {};
// A manifest with the two fixture models as plain tables; `config` overrides fct_wide's config.
const manifestWith = (config = {}) => ({
  nodes: {
    "model.proj.fct_wide": { resource_type: "model", name: "fct_wide", config: { materialized: "table", pre_hook: [], post_hook: [], ...config } },
    "model.proj.fct_narrow": { resource_type: "model", name: "fct_narrow", config: { materialized: "table", pre_hook: [], post_hook: [] } },
    "test.proj.fct_wide": { resource_type: "test", name: "fct_wide", config: {} },
  },
});
const MANIFEST = manifestWith();

test("byte counts take units and refuse junk", () => {
  assert.equal(parseBytes("2 MB", "x"), 2000000);
  assert.equal(parseBytes("10 GiB", "x"), 10737418240);
  assert.equal(parseBytes("1048576", "x"), 1048576);
  for (const bad of ["", "ten", "5 parsecs", "0", "-1 GB"]) assert.throws(() => parseBytes(bad, "x"), Fail, bad);
});

test("the budget file: default, models, and anything else is an error", () => {
  assert.deepEqual(parseBudgets(BUDGETS), { default: 2000000, models: { fct_wide: 2000000 }, accept: {} });
  assert.deepEqual(parseBudgets("default: 1 GB\naccept_unmeasured:\n  fct_x: merge reviewed\n").accept, { fct_x: "merge reviewed" });
  assert.throws(() => parseBudgets("accept_unmeasured:\n  a: x\n  a: y\n"), /twice/);
  assert.throws(() => parseBudgets("defualt: 1 GB\n"), /not understood/);
  assert.throws(() => parseBudgets("models:\n  a: 1 GB\n  a: 2 GB\n"), /twice/);
  assert.throws(() => parseBudgets("models:\n  a: lots\n"), /not a byte count/);
});

test("SELECT * over its budget fails the gate; the narrow model passes", async () => {
  const lines = [];
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_wide"], project: "p", token: "t", fetchImpl: stub(), log: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /OVER fct_wide: 6432064 bytes processed, budget 2000000/);
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_narrow"], project: "p", token: "t", fetchImpl: stub(), log: quiet }), 0);
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_narrow", "fct_wide"], project: "p", token: "t", fetchImpl: stub(), log: quiet }), 1);
});

test("the request is a dry run with no cache, and the token goes only in the Authorization header", async () => {
  const calls = [];
  await dryRun({ sql: "select word from x", project: "my-proj", location: "US", token: "secret-token", fetchImpl: stub(calls) });
  assert.equal(calls[0].url, "https://bigquery.googleapis.com/bigquery/v2/projects/my-proj/jobs");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.configuration.dryRun, true);
  assert.equal(body.configuration.query.useQueryCache, false);
  assert.equal(body.jobReference.location, "US");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  assert.doesNotMatch(calls[0].init.body, /secret-token/);
});

test("fails closed: no budget, no compiled file, an API error, no token, no bytes", async () => {
  const base = { compiledDir: COMPILED, manifest: MANIFEST, project: "p", token: "t", fetchImpl: stub(), log: quiet };
  await assert.rejects(check({ ...base, budgetsText: "models:\n  other: 1 GB\n", models: ["fct_wide"] }), (e) => e.code === 2);
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_missing"] }), (e) => e.code === 3);
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], token: "" }), (e) => e.code === 2);
  const http = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Access Denied" } }) });
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], fetchImpl: http }), (e) => e.code === 3 && /403: Access Denied/.test(e.message));
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ statistics: {} }) });
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], fetchImpl: empty }), (e) => e.code === 3);
  assert.equal(await check({ ...base, budgetsText: BUDGETS, models: [] }), 0, "no changed model is a pass");
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], manifest: undefined }), (e) => e.code === 2);
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], manifest: { nodes: {} } }), (e) => e.code === 3 && /no model of that name/.test(e.message));
});

// An external (GCS-backed) table dry-runs at 0 bytes with LOWER_BOUND; the review measured 2626682880
// bytes billed for the same query. The gate before this fix read only the number and passed it.
test("NOT MEASURED: an estimate that is a lower bound (external table) fails, whatever the bytes", async () => {
  const base = { budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_narrow"], project: "p", token: "t", log: quiet };
  const external = async () => ({ ok: true, status: 200, json: async () => ({ statistics: { query: { totalBytesProcessed: "0", totalBytesProcessedAccuracy: "LOWER_BOUND", statementType: "SELECT" } } }) });
  await assert.rejects(check({ ...base, fetchImpl: external }), (e) => e.code === 3 && /NOT MEASURED: the estimate is LOWER_BOUND/.test(e.message) && /fct_narrow/.test(e.message));
  await assert.rejects(check({ ...base, fetchImpl: stub([], { totalBytesProcessedAccuracy: undefined }) }), (e) => e.code === 3 && /unknown accuracy/.test(e.message));
  await assert.rejects(check({ ...base, fetchImpl: stub([], { totalBytesProcessedAccuracy: "UNKNOWN" }) }), (e) => e.code === 3);
  assert.equal(await check({ ...base, fetchImpl: stub([], { totalBytesProcessedAccuracy: "UPPER_BOUND" }) }), 0, "an upper bound can be checked");
});

// EXECUTE IMMEDIATE "SELECT * FROM <38 GB table>" dry-runs as SCRIPT, 0 bytes, PRECISE.
test("NOT MEASURED: SQL that BigQuery reads as a script fails", async () => {
  const script = async () => ({ ok: true, status: 200, json: async () => ({ statistics: { query: { totalBytesProcessed: "0", totalBytesProcessedAccuracy: "PRECISE", statementType: "SCRIPT" } } }) });
  await assert.rejects(check({ budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_narrow"], project: "p", token: "t", fetchImpl: script, log: quiet }), (e) => e.code === 3 && /script/.test(e.message));
});

test("NOT MEASURED: hooks, a sql_header and an incremental MERGE fail unless accepted with a reason", async () => {
  const cases = [
    [{ pre_hook: [{ sql: "delete from x where true", transaction: true }] }, "pre_hook"],
    [{ post_hook: [{ sql: "insert into audit select * from big", transaction: true }] }, "post_hook"],
    [{ sql_header: "create temp function f() as ((select count(*) from big));" }, "sql_header"],
    [{ materialized: "incremental" }, "incremental MERGE target scan"],
  ];
  for (const [config, part] of cases) {
    assert.deepEqual(unmeasuredParts(manifestWith(config), "fct_wide"), [part]);
    const base = { compiledDir: COMPILED, manifest: manifestWith(config), models: ["fct_narrow", "fct_wide"], project: "p", token: "t", fetchImpl: stub() };
    await assert.rejects(check({ ...base, budgetsText: "default: 100 MB\n", log: quiet }), (e) => e.code === 3 && e.message.startsWith(`NOT MEASURED fct_wide: its ${part}`), part);
    const lines = [];
    const accepted = "default: 100 MB\naccept_unmeasured:\n  fct_wide: reviewed by hand\n";
    assert.equal(await check({ ...base, budgetsText: accepted, log: (l) => lines.push(l) }), 0, part);
    assert.ok(lines.includes(`note fct_wide: ${part} not measured (accepted: reviewed by hand)`), lines.join("\n"));
    assert.ok(lines.includes("ok   fct_wide: 6432064 bytes processed, budget 100000000"), lines.join("\n"));
  }
  assert.deepEqual(unmeasuredParts(manifestWith({ pre_hook: [{ sql: "  " }], sql_header: null }), "fct_wide"), [], "empty hooks are nothing to measure");
});

test("the CLI refuses an unknown flag", async () => {
  await assert.rejects(main(["--budget", "x"], {}), (e) => e.code === 2);
  await assert.rejects(main(["--budgets", path.join(FIX, "warehouse-budgets.yml"), "--compiled-dir", COMPILED, "--models", "fct_wide", "--project", "p"], {}), (e) => e.code === 2 && /--manifest/.test(e.message));
});

const live = process.env.BQ_ACCESS_TOKEN && process.env.BQ_LIVE_PROJECT;
test("live: the fixture models dry-run on BigQuery, and SELECT * fails its budget", { skip: !live && "set BQ_ACCESS_TOKEN and BQ_LIVE_PROJECT to dry-run on BigQuery" }, async () => {
  const lines = [];
  const code = await check({ budgetsText: BUDGETS, compiledDir: COMPILED, manifest: MANIFEST, models: ["fct_narrow", "fct_wide"], project: process.env.BQ_LIVE_PROJECT, location: "US", token: process.env.BQ_ACCESS_TOKEN, log: (l) => lines.push(l) });
  console.log(lines.join("\n"));
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /ok   fct_narrow: \d+ bytes/);
  assert.match(lines.join("\n"), /OVER fct_wide: \d+ bytes/);
});
