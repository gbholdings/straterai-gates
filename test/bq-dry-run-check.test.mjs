// Tests for scripts/bq-dry-run-check.mjs. The fetch to BigQuery is stubbed, except in the last test,
// which dry-runs the fixture models for real when BQ_ACCESS_TOKEN and BQ_LIVE_PROJECT are set.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, parseBudgets, parseBytes, dryRun, main, Fail } from "../scripts/bq-dry-run-check.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bq-dry-run");
const COMPILED = path.join(FIX, "compiled");
const BUDGETS = fs.readFileSync(path.join(FIX, "warehouse-budgets.yml"), "utf8");
// The bytes BigQuery reported for the two fixture queries on 2026-10-30.
const MEASURED = { "select *": 6432064, "select word": 1332943 };
const stub = (calls = []) => async (url, init) => {
  calls.push({ url, init });
  const sql = JSON.parse(init.body).configuration.query.query;
  const key = Object.keys(MEASURED).find((k) => sql.startsWith(k));
  return { ok: true, status: 200, json: async () => ({ statistics: { query: { totalBytesProcessed: String(MEASURED[key]) } } }) };
};
const quiet = () => {};

test("byte counts take units and refuse junk", () => {
  assert.equal(parseBytes("2 MB", "x"), 2000000);
  assert.equal(parseBytes("10 GiB", "x"), 10737418240);
  assert.equal(parseBytes("1048576", "x"), 1048576);
  for (const bad of ["", "ten", "5 parsecs", "0", "-1 GB"]) assert.throws(() => parseBytes(bad, "x"), Fail, bad);
});

test("the budget file: default, models, and anything else is an error", () => {
  assert.deepEqual(parseBudgets(BUDGETS), { default: 2000000, models: { fct_wide: 2000000 } });
  assert.throws(() => parseBudgets("defualt: 1 GB\n"), /not understood/);
  assert.throws(() => parseBudgets("models:\n  a: 1 GB\n  a: 2 GB\n"), /twice/);
  assert.throws(() => parseBudgets("models:\n  a: lots\n"), /not a byte count/);
});

test("SELECT * over its budget fails the gate; the narrow model passes", async () => {
  const lines = [];
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, models: ["fct_wide"], project: "p", token: "t", fetchImpl: stub(), log: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /OVER fct_wide: 6432064 bytes processed, budget 2000000/);
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, models: ["fct_narrow"], project: "p", token: "t", fetchImpl: stub(), log: quiet }), 0);
  assert.equal(await check({ budgetsText: BUDGETS, compiledDir: COMPILED, models: ["fct_narrow", "fct_wide"], project: "p", token: "t", fetchImpl: stub(), log: quiet }), 1);
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
  const base = { compiledDir: COMPILED, project: "p", token: "t", fetchImpl: stub(), log: quiet };
  await assert.rejects(check({ ...base, budgetsText: "models:\n  other: 1 GB\n", models: ["fct_wide"] }), (e) => e.code === 2);
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_missing"] }), (e) => e.code === 3);
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], token: "" }), (e) => e.code === 2);
  const http = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Access Denied" } }) });
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], fetchImpl: http }), (e) => e.code === 3 && /403: Access Denied/.test(e.message));
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ statistics: {} }) });
  await assert.rejects(check({ ...base, budgetsText: BUDGETS, models: ["fct_wide"], fetchImpl: empty }), (e) => e.code === 3);
  assert.equal(await check({ ...base, budgetsText: BUDGETS, models: [] }), 0, "no changed model is a pass");
});

test("the CLI refuses an unknown flag", async () => {
  await assert.rejects(main(["--budget", "x"], {}), (e) => e.code === 2);
});

const live = process.env.BQ_ACCESS_TOKEN && process.env.BQ_LIVE_PROJECT;
test("live: the fixture models dry-run on BigQuery, and SELECT * fails its budget", { skip: !live && "set BQ_ACCESS_TOKEN and BQ_LIVE_PROJECT to dry-run on BigQuery" }, async () => {
  const lines = [];
  const code = await check({ budgetsText: BUDGETS, compiledDir: COMPILED, models: ["fct_narrow", "fct_wide"], project: process.env.BQ_LIVE_PROJECT, location: "US", token: process.env.BQ_ACCESS_TOKEN, log: (l) => lines.push(l) });
  console.log(lines.join("\n"));
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /ok   fct_narrow: \d+ bytes/);
  assert.match(lines.join("\n"), /OVER fct_wide: \d+ bytes/);
});
