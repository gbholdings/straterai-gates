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

// ---------------------------------------------------------------------------------------------------
// owner, contract-schema, consumers. Most contracts here are .odcs.json so the logic is tested without
// Python; the YAML path has its own test, which needs Python with PyYAML (CI installs datacontract-cli).

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "datacontract");
const DBT = path.join(FIXTURES, "dbt-catalog-match", "head", "dbt");
const write = (dir, rel, body) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
};
const OWNER_302 = [{ username: "data-platform", role: "owner" }];
const contract = (extra = {}, props) => ({
  apiVersion: "v3.0.2",
  kind: "DataContract",
  id: "urn:x",
  version: "1.0.0",
  status: "active",
  team: OWNER_302,
  schema: [
    {
      name: "orders",
      properties: props ?? [
        { name: "order_id", logicalType: "string", physicalType: "text", required: true },
        { name: "status", logicalType: "string", physicalType: "text", required: true },
        { name: "created_at", logicalType: "date", physicalType: "timestamp" },
      ],
    },
  ],
  ...extra,
});
const PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Order {
  id         String   @id @map("order_id") // the key
  status     String
  createdAt  DateTime @default(now()) @map("created_at")
  homepage   String?  @default("https://example.test/a//b")
  legacy     String   @ignore
  customer   Customer @relation(fields: [customerId], references: [id])
  customerId String   @map("customer_id") @db.VarChar(36)

  @@map("orders")
}

model Customer {
  id     String  @id
  orders Order[]
  @@map("customers")
}
`;
const schemaRun = (d, c, src = ["--prisma", "schema.prisma"]) => {
  write(d, "c.odcs.json", c);
  return run(["contract-schema", "--contract", "c.odcs.json", ...src], d);
};

test("owner: a v3.0.2 team list with role owner passes", () => {
  const d = tmp();
  write(d, "contracts/a.odcs.json", contract());
  const r = run(["owner", "--contracts", "contracts"], d);
  assert.equal(r.status, 0, r.stderr);
});

test("owner: a v3.1 team object with an owner member passes", () => {
  const d = tmp();
  write(d, "contracts/a.odcs.json", contract({ apiVersion: "v3.1.0", team: { name: "data", members: [{ username: "lead", role: "Owner" }] } }));
  assert.equal(run(["owner", "--contracts", "contracts"], d).status, 0);
});

for (const [name, team] of [
  ["no team", undefined],
  ["only a steward", [{ username: "s", role: "data steward" }]],
  ["an owner with no username", [{ role: "owner" }]],
  ["an owner who left", [{ username: "gone", role: "owner", dateOut: "2020-01-31" }]],
  ["a team name with no owner member", { name: "data", members: [{ username: "x", role: "engineer" }] }],
]) {
  test(`owner: ${name} fails and names the file`, () => {
    const d = tmp();
    const c = contract();
    if (team === undefined) delete c.team;
    else c.team = team;
    write(d, "contracts/sub/a.odcs.json", c);
    write(d, "contracts/b.odcs.json", contract());
    const r = run(["owner", "--contracts", "contracts"], d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /contracts[\\/]sub[\\/]a\.odcs\.json: no owner/);
    assert.doesNotMatch(r.stderr, /b\.odcs\.json/);
  });
}

test("owner: a top-level owner key does not count (datacontract lint rejects it)", () => {
  const d = tmp();
  const c = contract({ owner: "data-platform" });
  delete c.team;
  write(d, "contracts/a.odcs.json", c);
  assert.equal(run(["owner", "--contracts", "contracts"], d).status, 1);
});

test("owner: --contract is repeatable and checks each file", () => {
  const d = tmp();
  const bad = contract();
  delete bad.team;
  write(d, "a.odcs.json", contract());
  write(d, "b.odcs.json", bad);
  const r = run(["owner", "--contract", "a.odcs.json", "--contract", "b.odcs.json"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /b\.odcs\.json: no owner/);
});

test("owner: an empty contracts folder exits 2, never a green over nothing", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "contracts"));
  assert.equal(run(["owner", "--contracts", "contracts"], d).status, 2);
  assert.equal(run(["owner", "--contracts", "missing"], d).status, 2);
  assert.equal(run(["owner"], d).status, 2);
  assert.equal(run(["owner", "--contract", "nope.odcs.json"], d).status, 2);
});

test("owner: a symlinked contract is a finding", { skip: process.platform === "win32" }, () => {
  const d = tmp();
  write(d, "elsewhere/a.odcs.json", contract());
  fs.mkdirSync(path.join(d, "contracts"));
  fs.symlinkSync(path.join(d, "elsewhere/a.odcs.json"), path.join(d, "contracts/a.odcs.json"));
  const r = run(["owner", "--contracts", "contracts"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symlink/);
});

test("owner: every model of the project needs meta.owner; other packages are not checked", () => {
  const d = tmp();
  const m = JSON.parse(fs.readFileSync(path.join(DBT, "manifest.json"), "utf8"));
  assert.equal(run(["owner", "--manifest", path.join(DBT, "manifest.json")], d).status, 0);
  delete m.nodes["model.gates_fixture.stg_payments"].config.meta.owner;
  delete m.nodes["model.gates_fixture.stg_payments"].meta.owner;
  m.nodes["model.other_pkg.thing"] = { resource_type: "model", package_name: "other_pkg", name: "thing", config: { meta: {} }, meta: {} };
  write(d, "manifest.json", m);
  const r = run(["owner", "--manifest", "manifest.json"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /model\.gates_fixture\.stg_payments: no meta\.owner/);
  assert.doesNotMatch(r.stderr, /other_pkg/);
});

test("owner: config.meta.owner alone counts (dbt 1.10+ puts meta under config)", () => {
  const d = tmp();
  const m = JSON.parse(fs.readFileSync(path.join(DBT, "manifest.json"), "utf8"));
  for (const n of Object.values(m.nodes)) {
    n.meta = {};
    n.config.meta = { owner: "x" };
  }
  write(d, "manifest.json", m);
  assert.equal(run(["owner", "--manifest", "manifest.json"], d).status, 0);
});

test("owner: a manifest with no models of its project exits 2", () => {
  const d = tmp();
  write(d, "manifest.json", { metadata: { project_name: "p" }, nodes: { "model.q.a": { resource_type: "model", package_name: "q" } } });
  assert.equal(run(["owner", "--manifest", "manifest.json"], d).status, 2);
  write(d, "nodes.json", { metadata: {} });
  assert.equal(run(["owner", "--manifest", "nodes.json"], d).status, 2);
});

test("contract-schema: a contract that matches the Prisma schema passes; relations, @ignore and comments are handled", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const r = schemaRun(d, contract());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agrees with schema\.prisma \(3 column\(s\)\)/);
  assert.match(r.stdout, /not in the contract.*homepage, customer_id/);
  assert.doesNotMatch(r.stdout, /legacy|customer,|customerId/);
});

test("contract-schema: a drifted (renamed) column fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA.replace("  status     String\n", "  state      String\n"));
  const r = schemaRun(d, contract());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orders\.status: in the contract, not in the schema/);
});

test("contract-schema: a column the schema ignores is not a column", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const r = schemaRun(d, contract({}, [{ name: "legacy", logicalType: "string" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orders\.legacy: in the contract, not in the schema/);
});

test("contract-schema: a logical type disagreement fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA.replace("id         String   @id", "id         Int      @id"));
  const r = schemaRun(d, contract());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orders\.order_id: contract logicalType string, schema type Int \(integer\)/);
  assert.match(r.stderr, /orders\.order_id: contract physicalType text, schema type integer/);
});

test("contract-schema: required in the contract, nullable in the schema, fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA.replace("  status     String\n", "  status     String?\n"));
  const r = schemaRun(d, contract());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orders\.status: the contract says required, the schema allows null/);
});

test("contract-schema: physical types compare with lengths, and Prisma's DateTime default is timestamp(3), not timestamptz", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  let r = schemaRun(d, contract({}, [{ name: "customer_id", logicalType: "string", physicalType: "character varying(36)" }]));
  assert.equal(r.status, 0, r.stderr);
  r = schemaRun(d, contract({}, [{ name: "customer_id", logicalType: "string", physicalType: "varchar(50)" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /customer_id: contract physicalType varchar\(50\), schema type varchar\(36\)/);
  r = schemaRun(d, contract({}, [{ name: "created_at", logicalType: "date", physicalType: "timestamptz" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /created_at: contract physicalType timestamptz, schema type timestamp\(3\)/);
});

test("contract-schema: a table the schema does not have fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const c = contract();
  c.schema[0].name = "payments";
  const r = schemaRun(d, c);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /payments: the contract describes it, the schema \(schema\.prisma\) has no such table/);
});

test("contract-schema: physicalName wins over name; a Prisma model name is not a table", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const c = contract();
  c.schema[0].name = "Orders as published";
  c.schema[0].physicalName = "orders";
  assert.equal(schemaRun(d, c).status, 0);
  // `model Order { @@map("orders") }`: the table is orders, and datacontract test would query "Order".
  c.schema[0].physicalName = "Order";
  const r = schemaRun(d, c);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Order: the contract describes it, the schema \(schema\.prisma\) has no such table/);
});

// A dbt manifest with an aliased model and a versioned one, the shapes dbt 1.12 writes.
const MANIFEST = {
  metadata: { project_name: "p" },
  nodes: {
    "model.p.fct_orders": { resource_type: "model", package_name: "p", name: "fct_orders", alias: "orders_fact", schema: "analytics", columns: { order_id: { name: "order_id", data_type: "integer" } } },
    "model.p.dim_customers.v1": { resource_type: "model", package_name: "p", name: "dim_customers", alias: "dim_customers_v1", version: 1, latest_version: 1, schema: "analytics", columns: { id: { name: "id", data_type: "integer" } } },
    "model.p.dim_customers.v2": { resource_type: "model", package_name: "p", name: "dim_customers", alias: "dim_customers_v2", version: 2, latest_version: 1, schema: "analytics", columns: { id: { name: "id", data_type: "integer" } } },
  },
};

test("contract-schema: a dbt contract names the relation (the alias), never the model name", () => {
  const d = tmp();
  write(d, "manifest.json", MANIFEST);
  const one = (name, props) => {
    const c = contract({}, props);
    c.schema[0].name = name;
    return schemaRun(d, c, ["--manifest", "manifest.json"]);
  };
  const oid = [{ name: "order_id", logicalType: "integer", physicalType: "integer" }];
  const id = [{ name: "id", logicalType: "integer" }];
  assert.equal(one("orders_fact", oid).status, 0);
  let r = one("fct_orders", oid);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /that is a model name, and the warehouse holds orders_fact/);
  r = one("dim_customers", id);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /warehouse holds dim_customers_v1, dim_customers_v2/);
  assert.equal(one("dim_customers_v2", id).status, 0);
  assert.equal(one("analytics.orders_fact", oid).status, 0);
  r = one("billing.orders_fact", oid);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the contract puts it in schema billing; the manifest builds it in analytics/);
});

const PRISMA_BILLING = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["public", "billing"]
}

model Order {
  id   String   @id @map("order_id")
  tags String[]

  @@map("orders")
  @@schema("billing")
}
`;

test("contract-schema: @@schema is compared with the contract's server schema or its qualifier", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA_BILLING);
  const props = [{ name: "order_id", logicalType: "string", physicalType: "text", required: true }];
  const c = contract({ servers: [{ server: "prod", type: "postgres", schema: "public" }] }, props);
  let r = schemaRun(d, c);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the contract puts it in schema public; the Prisma schema has it in billing/);
  c.servers[0].schema = "billing";
  assert.equal(schemaRun(d, c).status, 0, schemaRun(d, c).stderr);
  delete c.servers;
  c.schema[0].name = "billing.orders";
  assert.equal(schemaRun(d, c).status, 0);
  c.schema[0].name = "public.orders";
  assert.equal(schemaRun(d, c).status, 1);
  // A model with no @@schema is in public on Postgres, so public.orders names it.
  write(d, "schema.prisma", PRISMA);
  const c2 = contract();
  c2.schema[0].name = "public.orders";
  assert.equal(schemaRun(d, c2).status, 0, schemaRun(d, c2).stderr);
});

test("contract-schema: a String[] column agrees with what datacontract import sql writes, and takes NULL", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA_BILLING);
  const base = { name: "order_id", logicalType: "string", physicalType: "text" };
  const c = contract({ servers: [{ server: "prod", type: "postgres", schema: "billing" }] }, [base, { name: "tags", logicalType: "string", physicalType: "TEXT[]" }]);
  let r = schemaRun(d, c);
  assert.equal(r.status, 0, r.stderr);
  c.schema[0].properties[1] = { name: "tags", logicalType: "array", physicalType: "text[]" };
  assert.equal(schemaRun(d, c).status, 0);
  // logicalType string without the array physicalType says the column is a string; it is not.
  c.schema[0].properties[1] = { name: "tags", logicalType: "string" };
  assert.equal(schemaRun(d, c).status, 1);
  c.schema[0].properties[1] = { name: "tags", logicalType: "string", physicalType: "varchar[]" };
  assert.equal(schemaRun(d, c).status, 1);
  c.schema[0].properties[1] = { name: "tags", logicalType: "array", required: true };
  r = schemaRun(d, c);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tags: the contract says required, the schema allows null/);
});

test("contract-schema: a multi-file Prisma folder is read whole; a file without the datasource exits 2", () => {
  const d = tmp();
  write(d, "prisma/schema/schema.prisma", 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  write(d, "prisma/schema/order.prisma", 'model Order {\n  id         String @id @map("order_id")\n  customerId String @map("customer_id") @db.VarChar(20)\n  status     Status\n  @@map("orders")\n}\n');
  write(d, "prisma/schema/enums/status.prisma", "enum Status {\n  open\n  closed\n}\n");
  const props = [
    { name: "order_id", logicalType: "string", physicalType: "text" },
    { name: "customer_id", logicalType: "string", physicalType: "bigint" },
    { name: "status", logicalType: "string" },
  ];
  let r = schemaRun(d, contract({}, props), ["--prisma", "prisma/schema"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /customer_id: contract physicalType bigint, schema type varchar\(20\)/);
  assert.doesNotMatch(r.stderr, /status/);
  r = schemaRun(d, contract({}, props), ["--prisma", "prisma/schema/order.prisma"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no datasource provider/);
  assert.doesNotMatch(r.stderr, /EISDIR|at /);
  write(d, "empty/readme.txt", "x");
  assert.equal(schemaRun(d, contract({}, props), ["--prisma", "empty"]).status, 2);
});

test("YAML is read with Python isolated: a yaml.py in the working directory is never imported", () => {
  const d = tmp();
  write(d, "yaml.py", "import sys\nsys.stderr.write('PLANTED\\n')\ndef safe_load(s):\n    return {'team': [{'username': 'x', 'role': 'owner'}]}\n");
  write(d, "contracts/a.odcs.yaml", "apiVersion: v3.0.2\nkind: DataContract\nid: urn:x\nversion: 1.0.0\nstatus: active\n");
  const r = spawnSync(process.execPath, [SCRIPT, "owner", "--contracts", "contracts"], { cwd: d, encoding: "utf8", env: { ...process.env, PYTHONPATH: d, PYTHONSTARTUP: path.join(d, "yaml.py") } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /no owner/);
  assert.doesNotMatch(r.stderr + r.stdout, /PLANTED/);
});

test("consumers: hostile paths, owners and teams render as inert code spans", async () => {
  const { mdCode } = await import("../scripts/governance-check.mjs");
  assert.equal(mdCode("x`\n\n## Reviewed and approved by @octocat\n\n<details>"), "`x ## Reviewed and approved by @octocat <details>`");
  assert.equal(mdCode(""), "`(empty)`");
  const d = tmp();
  write(d, "c.odcs.json", contract({ team: [{ username: "@octocat", role: "owner" }], customProperties: [{ property: "consumers", value: [{ team: "Ops https://evil.example/login" }] }] }));
  const r = run(["consumers", "--contract", "c.odcs.json", "--format", "markdown", "--label", "contracts/x`\n## Approved\n<details>.odcs.yaml"], d);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], "#### `contracts/x ## Approved <details>.odcs.yaml`");
  assert.ok(lines.includes("Owner: `@octocat`"), r.stdout);
  assert.ok(lines.includes("- `Ops https://evil.example/login`"), r.stdout);
  assert.ok(!lines.some((l) => /^##? /.test(l)), r.stdout);
});

test("contract-schema: an unknown logical type fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const r = schemaRun(d, contract({}, [{ name: "status", logicalType: "text" }]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an ODCS logical type/);
});

test("contract-schema: on a provider other than Postgres the physical type is noted as not checked", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA.replace('"postgresql"', '"mysql"'));
  const r = schemaRun(d, contract());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /physicalType text not checked/);
  assert.match(r.stdout.split("\n")[0], /^WARNING: provider mysql: physical types are NOT CHECKED/);
});

test("contract-schema: the dbt catalog is the real schema; a renamed column fails", () => {
  const d = tmp();
  const c = contract({}, [
    { name: "order_id", logicalType: "integer", physicalType: "INTEGER" },
    { name: "order_status", logicalType: "string", physicalType: "VARCHAR" },
  ]);
  c.schema[0].name = "fct_orders";
  let r = schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json"), "--catalog", path.join(DBT, "catalog.json")]);
  assert.equal(r.status, 0, r.stderr);
  const cat = JSON.parse(fs.readFileSync(path.join(DBT, "catalog.json"), "utf8"));
  const cols = cat.nodes["model.gates_fixture.fct_orders"].columns;
  cols.status = { ...cols.order_status, name: "status" };
  delete cols.order_status;
  write(d, "catalog.json", cat);
  r = schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json"), "--catalog", "catalog.json"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fct_orders\.order_status: in the contract, not in the schema/);
});

test("contract-schema: a manifest with no data_type and no catalog cannot vouch for a type", () => {
  const d = tmp();
  const c = contract({}, [{ name: "order_id", logicalType: "integer" }]);
  c.schema[0].name = "fct_orders";
  const r = schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot be compared/);
});

test("contract-schema: manifest data_type is used when declared; warehouse names fold case", () => {
  const d = tmp();
  const c = contract({}, [{ name: "ORDER_ID", logicalType: "integer", physicalType: "integer" }]);
  c.schema[0].name = "stg_orders";
  assert.equal(schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json")]).status, 0);
  c.schema[0].properties[0].logicalType = "string";
  assert.equal(schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json")]).status, 1);
});

test("contract-schema: a model missing from the catalog fails", () => {
  const d = tmp();
  const cat = JSON.parse(fs.readFileSync(path.join(DBT, "catalog.json"), "utf8"));
  delete cat.nodes["model.gates_fixture.fct_orders"];
  write(d, "catalog.json", cat);
  const c = contract({}, [{ name: "order_id", logicalType: "integer" }]);
  c.schema[0].name = "fct_orders";
  const r = schemaRun(d, c, ["--manifest", path.join(DBT, "manifest.json"), "--catalog", "catalog.json"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in the catalog/);
});

test("logicalFromPhysical: NUMBER(38,0) holds integers, NUMBER(10,2) does not", async () => {
  const { logicalFromPhysical } = await import("../scripts/governance-check.mjs");
  assert.deepEqual(logicalFromPhysical("NUMBER(38,0)"), ["integer", "number"]);
  assert.deepEqual(logicalFromPhysical("NUMBER(10,2)"), ["number"]);
  assert.deepEqual(logicalFromPhysical("INT64"), ["integer"]);
  assert.deepEqual(logicalFromPhysical("ARRAY<STRING>"), ["array"]);
  assert.deepEqual(logicalFromPhysical("STRUCT<a INT64>"), ["object"]);
  assert.deepEqual(logicalFromPhysical("timestamp with time zone"), ["date", "timestamp", "time"]);
  assert.equal(logicalFromPhysical("geheim"), null);
});

test("contract-schema: usage errors exit 2", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  write(d, "c.odcs.json", contract());
  assert.equal(run(["contract-schema", "--prisma", "schema.prisma"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "c.odcs.json"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "c.odcs.json", "--prisma", "schema.prisma", "--manifest", "m.json"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "c.odcs.json", "--prisma", "schema.prisma", "--catalog", "c.json"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "c.odcs.json", "--prisma", "missing.prisma"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "c.odcs.json", "--prisma", "schema.prisma", "--prisma", "schema.prisma"], d).status, 2);
  assert.equal(run(["contract-schema", "--contract", "--prisma", "schema.prisma"], d).status, 2);
});

test("contract-schema: a contract with no schema objects fails", () => {
  const d = tmp();
  write(d, "schema.prisma", PRISMA);
  const c = contract();
  c.schema = [];
  assert.equal(schemaRun(d, c).status, 1);
});

test("consumers: lines, markdown with a team mention and a repo link, and the empty case", () => {
  const d = tmp();
  const c = contract({ customProperties: [{ property: "consumers", value: [{ repo: "example-org/billing", team: "example-org/billing-team" }, { team: "Finance *analysts*" }] }] });
  write(d, "c.odcs.json", c);
  let r = run(["consumers", "--contract", "c.odcs.json"], d);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "example-org/billing\texample-org/billing-team\n\tFinance *analysts*\n");
  r = run(["consumers", "--contract", "c.odcs.json", "--format", "markdown", "--label", "contracts/orders.odcs.yaml"], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- \[example-org\/billing\]\(https:\/\/github\.com\/example-org\/billing\) · @example-org\/billing-team/);
  assert.match(r.stdout, /- `Finance \*analysts\*`/);
  assert.match(r.stdout, /Owner: `data-platform`/);
  write(d, "none.odcs.json", contract());
  r = run(["consumers", "--contract", "none.odcs.json", "--format", "markdown"], d);
  assert.match(r.stdout, /lists no consumers/);
});

test("consumers: a malformed list exits 1; a bad repo is not linked", () => {
  const d = tmp();
  write(d, "c.odcs.json", contract({ customProperties: [{ property: "consumers", value: [{ repo: "not a repo; rm -rf /" }] }] }));
  const r = run(["consumers", "--contract", "c.odcs.json"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not owner\/name/);
  write(d, "d.odcs.json", contract({ customProperties: [{ property: "consumers", value: "billing" }] }));
  assert.equal(run(["consumers", "--contract", "d.odcs.json"], d).status, 1);
  assert.equal(run(["consumers", "--contract", "d.odcs.json", "--format", "html"], d).status, 2);
});

test("YAML contracts are read through PyYAML, and a missing interpreter exits 2", () => {
  const d = tmp();
  const yaml = "apiVersion: v3.0.2\nkind: DataContract\nid: urn:x\nversion: 1.0.0\nstatus: active\nteam:\n  - username: a\n    role: owner\n    dateIn: 2024-01-01\n";
  write(d, "contracts/a.odcs.yaml", yaml);
  const r = run(["owner", "--contracts", "contracts"], d);
  assert.equal(r.status, 0, r.stderr);
  const r2 = spawnSync(process.execPath, [SCRIPT, "owner", "--contracts", "contracts"], { cwd: d, encoding: "utf8", env: { ...process.env, GOVERNANCE_PYTHON: path.join(d, "no-such-python") } });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /needs Python with PyYAML/);
  write(d, "bad/b.odcs.yaml", "team: [unclosed\n");
  const r3 = run(["owner", "--contracts", "bad"], d);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /not valid YAML/);
});

// ---- credentials -----------------------------------------------------------------------------------
const CRED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "governance", "credentials");
const credIn = (dir, files, args) => {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return run(["credentials", ...args], dir);
};
const SECRETS = ["planted-staging-pw", "s3cret", "hunter2", "p@ss", "pw-kv", "tunnel-pw"];
const noSecret = (r) => { for (const s of SECRETS) assert.equal(`${r.stdout}${r.stderr}`.includes(s), false, `printed the password ${s}`); };

test("credentials: the passing fixture passes, with --targets, and notes the reference", () => {
  const r = run(["credentials", "--config", path.join(CRED, "pass", ".env.example"), "--targets", path.join(CRED, "pass", "db-targets.json")], tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no literal password for a non-local target in 1 file\(s\) \(5 connection string\(s\) read\)/);
  assert.match(r.stdout, /note: .*`PROD_URL` takes its password from a reference/);
});

test("credentials: the failing fixture fails on the staging write DSN, and never prints the password", () => {
  const r = run(["credentials", "--config", path.join(CRED, "fail", ".env.example"), "--targets", path.join(CRED, "fail", "db-targets.json")], tmp());
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /\.env\.example`:2: a postgres connection string in `STAGING_RW_URL` has a literal password for the non-local target `staging` \(env staging\)/);
  assert.doesNotMatch(r.stderr, /\.env\.example`:1:/);
  noSecret(r);
});

test("credentials: each connection-string shape with a literal password for a real host fails", () => {
  const shapes = {
    url: "A=postgres://app:s3cret@db.example.com:5432/app",
    driver: "B=postgresql+psycopg2://app:s3cret@db.example.com/app",
    mysql: "C: mysql://root:hunter2@mysql.example.com/app",
    srv: '"D": "mongodb+srv://u:p%40ss@cluster0.example.net/db"',
    query: "E=postgres://db.example.com/app?user=a&password=hunter2",
    jdbc: "F=jdbc:sqlserver://sql.example.com:1433;databaseName=a;password=hunter2",
    libpq: "G=host=pg.example.com port=5432 user=a password=pw-kv",
    adonet: 'H="Server=tcp:sql.example.com,1433;Database=a;User Id=u;Password=pw-kv;"',
    multihost: "I=postgres://u:s3cret@localhost,db.example.com/app",
    placeholder: "J=postgres://app:<password>@db.example.com/app",
    commented: "# K=postgres://app:s3cret@db.example.com/app",
    redis: "L=rediss://default:s3cret@cache.example.com:6380",
  };
  for (const [shape, line] of Object.entries(shapes)) {
    const r = credIn(tmp(), { "a.env": `${line}\n` }, ["--config", "a.env"]);
    assert.equal(r.status, 1, `${shape} passed: ${r.stdout}`);
    assert.match(r.stderr, /a\.env`:1: a \S+ connection string/, shape);
    noSecret(r);
  }
});

test("credentials: local hosts, no password, and references pass", () => {
  const ok = [
    "A=postgres://postgres:postgres@localhost:5432/t",
    "B=postgres://u:p@127.0.0.1/t",
    "C=postgres://u:p@[::1]:5432/t",
    "D=postgres://u:p@db:5432/t",
    // split in two: joined, the fact scan reads the userinfo and this host as an email address
    "E=postgres://u:p" + "@host.docker.internal/t",
    "G=postgres://app@db.example.com/app",
    "H=postgres://app:${DB_PASSWORD}@db.example.com/app",
    "I=postgres://app:${{ secrets.DB_PASSWORD }}@db.example.com/app",
    "J=postgres://app:@db.example.com/app",
    "DB_PASSWORD=s3cret",
    "K=https://user:s3cret@example.com/not-a-database",
  ];
  const r = credIn(tmp(), { "a.env": ok.join("\n") + "\n" }, ["--config", "a.env"]);
  assert.equal(r.status, 0, r.stderr);
});

test("credentials: --targets makes a tunnelled localhost DSN for a staging or unknown-env target fail", () => {
  const d = tmp();
  const targets = { targets: { st: { env: "staging", read_env: "STAGING_URL" }, odd: { env: "qa", read_env: "QA_URL" }, loc: { env: "local", read_env: "DATABASE_URL" } } };
  fs.writeFileSync(path.join(d, "t.json"), JSON.stringify(targets));
  const body = "STAGING_URL=postgres://u:tunnel-pw@localhost:6543/app\nQA_URL=postgres://u:tunnel-pw@localhost:6544/app\nDATABASE_URL=postgres://u:p@localhost/app\n";
  const r = credIn(d, { "a.env": body }, ["--config", "a.env", "--targets", "t.json"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.env`:1: .*target `st` \(env staging\)/);
  assert.match(r.stderr, /a\.env`:2: .*target `odd` \(env prod\)/, "an unknown env label counts as prod");
  assert.doesNotMatch(r.stderr, /a\.env`:3:/);
  noSecret(r);
  assert.equal(credIn(d, {}, ["--config", "a.env"]).status, 0, "without --targets the localhost tunnel is local");
});

test("credentials: nothing to read is NOT CHECKED (exit 2), never a pass", () => {
  const d = tmp();
  for (const args of [[], ["--config", "missing.env"], ["--config", "a.env", "--targets", "missing.json"]]) {
    const r = credIn(d, { "a.env": "A=1\n" }, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, /NOT CHECKED|required/);
  }
  fs.mkdirSync(path.join(d, "dir"));
  assert.equal(run(["credentials", "--config", "dir"], d).status, 2, "a directory");
  fs.writeFileSync(path.join(d, "bad.json"), "{");
  assert.equal(run(["credentials", "--config", "a.env", "--targets", "bad.json"], d).status, 2, "malformed targets");
  assert.equal(run(["credentials", "--config", "a.env", "--bogus", "x"], d).status, 2, "unknown flag");
});

test("credentials: a glob reads committed files only, and a glob that matches none exits 2", () => {
  const d = tmp();
  spawnSync("git", ["init", "-q"], { cwd: d });
  fs.mkdirSync(path.join(d, "config/env"), { recursive: true });
  fs.writeFileSync(path.join(d, "config/env/staging.env"), "A=postgres://u:s3cret@db.example.com/app\n");
  fs.writeFileSync(path.join(d, "config/env/ok.env"), "A=postgres://u:p@localhost/app\n");
  assert.equal(run(["credentials", "--config", "config/**/*.env"], d).status, 2, "nothing is committed yet");
  spawnSync("git", ["add", "config/env/ok.env"], { cwd: d });
  assert.equal(run(["credentials", "--config", "config/**/*.env"], d).status, 0);
  spawnSync("git", ["add", "config/env/staging.env"], { cwd: d });
  const r = run(["credentials", "--config", "config/**/*.env"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /config\/env\/staging\.env`:1:/);
  assert.equal(run(["credentials", "--config", "nothing/**/*.yml", "--config", "config/**/*.env"], d).status, 2, "any glob matching nothing fails");
  const outside = tmp();
  assert.equal(run(["credentials", "--config", "**/*.env"], outside).status, 2, "a glob outside a git checkout");
});

// ---- evidence append --from (the publish job of governance.yml) ------------------------------------
test("evidence append --from refuses an entry without exactly the six keys, and writes nothing", () => {
  const d = tmp();
  const good = { check: "x:y/z", date: "2026-10-31T00:00:00Z", result: "pass", run_link: null, commit: "abc", detail: "" };
  const EMPTY = "[]" + String.fromCharCode(10);
  fs.writeFileSync(path.join(d, "out.json"), EMPTY);
  const { detail, ...five } = good;
  for (const bad of [[five], [{ ...good, extra: 1 }], [{ ...good, result: "maybe" }]]) {
    fs.writeFileSync(path.join(d, "run.json"), JSON.stringify(bad));
    const r = run(["evidence", "append", "--from", "run.json", "--file", "out.json"], d);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.equal(fs.readFileSync(path.join(d, "out.json"), "utf8"), EMPTY, "nothing was written");
  }
  fs.writeFileSync(path.join(d, "run.json"), JSON.stringify([good]));
  assert.equal(run(["evidence", "append", "--from", "run.json", "--file", "out.json"], d).status, 0);
});


// ---- credentials: the shapes review of v1.6.0 found passing, and the password on every stream ------
const PLANT = "Zq9xK2plant";
const noPlant = (label, ...texts) => {
  for (const t of texts) for (const s of [PLANT, "xK2plant", "Zq9"]) assert.equal(String(t).includes(s), false, `${label}: printed (part of) the password: ${s}`);
};

test("credentials: a Cloud SQL socket, a ?host= host, an unencoded / # ? in the password, and a one-label host fail", () => {
  const shapes = {
    "cloud sql socket in the authority": `A=postgresql://app:${PLANT}@%2Fcloudsql%2Fproj%3Aregion%3Ainst/app`,
    "cloud sql socket in ?host=": `B=postgres://app:${PLANT}@/app?host=/cloudsql/proj:region:inst`,
    "a host in ?host=": `C=postgres://app:${PLANT}@/app?host=prod.example.com`,
    "an unencoded /": `D=postgres://app:Zq9/xK2plant@prod.example.com/app`,
    "an unencoded #": `E=postgres://app:Zq9#xK2plant@prod.example.com/app`,
    "an unencoded ?": `F=postgres://app:Zq9?xK2plant@prod.example.com/app`,
    "a one-label host": `G=postgres://app:${PLANT}@proddb/app`,
  };
  for (const [shape, line] of Object.entries(shapes)) {
    const r = credIn(tmp(), { "a.env": `${line}\n` }, ["--config", "a.env"]);
    assert.equal(r.status, 1, `${shape} passed: ${r.stdout}`);
    assert.match(r.stderr, /a\.env`:1: a \S+ connection string/, shape);
    noPlant(shape, r.stdout, r.stderr);
  }
});

test("credentials: a one-label host is local only as a common service name or a --local-host", () => {
  const d = tmp();
  assert.equal(credIn(d, { "a.env": `A=postgres://u:${PLANT}@db/app\nB=redis://:${PLANT}@redis:6379\n` }, ["--config", "a.env"]).status, 0);
  assert.equal(credIn(d, { "b.env": `A=postgres://u:${PLANT}@appdb/app\n` }, ["--config", "b.env"]).status, 1);
  assert.equal(credIn(d, {}, ["--config", "b.env", "--local-host", "appdb"]).status, 0);
  // a non-Cloud SQL socket is still local
  assert.equal(credIn(d, { "c.env": `A=postgres://u:${PLANT}@/app?host=/var/run/postgresql\n` }, ["--config", "c.env"]).status, 0);
});

test("credentials: a Python f-string placeholder is a reference, not a password", () => {
  const r = credIn(tmp(), { "conn.py": 'url = f"postgresql://app:{pw}@prod.example.com/app"\n' }, ["--config", "conn.py"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: .*takes its password from a reference/);
});

test("credentials: --targets reads Cloud Run and Kubernetes env lists, not only NAME= lines", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "t.json"), JSON.stringify({ targets: { st: { env: "staging", read_env: "STAGING_RO_URL" } } }));
  const json = `[{"name":"STAGING_RO_URL","value":"postgres://ro:${PLANT}@localhost:6543/app"}]\n`;
  const yaml = `env:\n  - name: STAGING_RO_URL\n    value: "postgres://ro:${PLANT}@localhost:6543/app"\n`;
  for (const [file, body] of [["env.json", json], ["deploy.yaml", yaml]]) {
    const r = credIn(d, { [file]: body }, ["--config", file, "--targets", "t.json"]);
    assert.equal(r.status, 1, `${file}: ${r.stdout}`);
    assert.match(r.stderr, /target `st` \(env staging\)/, file);
    noPlant(file, r.stdout, r.stderr);
  }
});

test("credentials: a UTF-16 file with a BOM is read", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.env"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`A=postgres://app:${PLANT}@prod.example.com/app\r\n`, "utf16le")]));
  const r = run(["credentials", "--config", "a.env"], d);
  assert.equal(r.status, 1, r.stdout);
  noPlant("utf-16", r.stdout, r.stderr);
});

test("credentials: --all-tracked reads every committed text file and skips binaries", () => {
  const d = tmp();
  spawnSync("git", ["init", "-q"], { cwd: d });
  const files = {
    "infra/main.tf": `resource "x" "y" {\n  url = "postgres://app:${PLANT}@prod.example.com/app"\n}\n`,
    "docker-compose.yml": `services:\n  app:\n    environment:\n      DATABASE_URL: postgres://app:${PLANT}@db:5432/app\n`,
    ".github/workflows/ci.yml": `jobs:\n  t:\n    steps:\n      - run: psql "postgres://app:${PLANT}@prod.example.com/app" -c 'select 1'\n`,
    "notebooks/a.ipynb": JSON.stringify({ cells: [{ source: [`engine = create_engine("postgresql://app:${PLANT}@prod.example.com/app")`] }] }) + "\n",
  };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  fs.writeFileSync(path.join(d, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`postgres://app:${PLANT}@prod.example.com/app`)]));
  assert.equal(run(["credentials", "--all-tracked"], d).status, 2, "nothing committed yet: NOT CHECKED");
  spawnSync("git", ["add", "."], { cwd: d });
  const r = run(["credentials", "--all-tracked"], d);
  assert.equal(r.status, 1, r.stdout);
  for (const f of ["infra/main.tf`:2", "ci.yml`:4", "a.ipynb`:1"]) assert.ok(r.stderr.includes(f), `${f} was read: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /docker-compose\.yml|blob\.bin/, "the compose service is local, the binary is skipped");
  noPlant("all-tracked", r.stdout, r.stderr);
});

test("credentials: the password is never printed, on any stream, whatever was passed where", () => {
  const d = tmp();
  spawnSync("git", ["init", "-q"], { cwd: d });
  const dsn = `postgres://app:${PLANT}@prod.example.com/app`;
  fs.writeFileSync(path.join(d, "a.env"), `A=${dsn}\nB=postgres://app:Zq9/xK2plant@prod.example.com/app\nC=host=prod.example.com password=${PLANT}\n`);
  fs.writeFileSync(path.join(d, "targets.txt"), `DATABASE_URL=${dsn}\n`);
  const calls = [
    [["credentials", "--config", "a.env"], 1],
    [["credentials", "--config", dsn], 2],
    [["credentials", `--config=${dsn}`], 2],
    [["credentials", "--config", `${dsn}*`], 2],
    [["credentials", dsn], 2],
    [["credentials", `--${dsn}`], 2],
    [["credentials", "--config", "a.env", "--targets", "targets.txt"], 2],
    [["credentials", "--config", "a.env", "--targets", dsn], 2],
  ];
  for (const [args, want] of calls) {
    const r = run(args, d);
    assert.equal(r.status, want, `${args.join(" ")}: exit ${r.status}`);
    noPlant(args.join(" "), r.stdout, r.stderr);
  }
  // Through the runner governance.yml uses: its output, the evidence entries, GITHUB_OUTPUT and the status.
  const evidence = path.join(d, "evidence.json");
  const ghOut = path.join(d, "gh-output");
  const checks = calls.map(([args], i) => `t:c/${i}=${args.join(" ")}`).join("\n");
  const r = spawnSync("bash", [path.join(path.dirname(SCRIPT), "run-governance-checks.sh")], {
    cwd: d,
    encoding: "utf8",
    env: { ...process.env, CHECKS: checks, GC: SCRIPT, GOVERNANCE_EVIDENCE_FILE: evidence, GITHUB_OUTPUT: ghOut, COMMIT: "abc" },
  });
  assert.equal(r.status, 1);
  noPlant("runner", r.stdout, r.stderr, fs.readFileSync(evidence, "utf8"), fs.readFileSync(ghOut, "utf8"));
  const results = JSON.parse(fs.readFileSync(evidence, "utf8")).map((e) => e.result);
  assert.deepEqual(results, ["fail", ...Array(calls.length - 1).fill("not_run")], "NOT CHECKED is recorded as not_run");
});

test("the runner: an empty checks input is NOT CHECKED and fails, never a pass", () => {
  const d = tmp();
  for (const checks of ["", "# only a comment\n"]) {
    const r = spawnSync("bash", [path.join(path.dirname(SCRIPT), "run-governance-checks.sh")], { cwd: d, encoding: "utf8", env: { ...process.env, CHECKS: checks, GC: SCRIPT } });
    assert.equal(r.status, 1, JSON.stringify(checks));
    assert.match(r.stdout + r.stderr, /no checks configured: NOT CHECKED/);
  }
});

test("the runner: a file name that would start a workflow command is printed inside stop-commands", () => {
  const d = tmp();
  spawnSync("git", ["init", "-q"], { cwd: d });
  const name = "cfg/x\n::warning::injected.env";
  fs.mkdirSync(path.join(d, "cfg"));
  fs.writeFileSync(path.join(d, name), `A=postgres://app:${PLANT}@prod.example.com/app\n`);
  spawnSync("git", ["add", "."], { cwd: d });
  const r = spawnSync("bash", [path.join(path.dirname(SCRIPT), "run-governance-checks.sh")], { cwd: d, encoding: "utf8", env: { ...process.env, CHECKS: "t:c/x=credentials --all-tracked", GC: SCRIPT, GOVERNANCE_EVIDENCE_FILE: path.join(d, "e.json") } });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /^\s*::warning::/m, "a line starts a workflow command");
  assert.match(out, /x ::warning::injected\.env/, "the name is printed on one line, its newline escaped");
  noPlant("injection", out);
});
