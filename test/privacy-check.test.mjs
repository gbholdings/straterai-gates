// governance-check: classification, deletion-map, retention, exports and evidence --from. Each check has a
// passing and a failing case, and each failing case turns green (the test red) if its check branch is deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "governance-check.mjs");
const FIX = "test/fixtures/governance/privacy";
const TIERS = `${FIX}/tiers.json`;
const run = (args, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gov-privacy-"));
const all = (r) => `${r.stdout}\n${r.stderr}`;

function gitRepo(files) {
  const d = tmp();
  const g = (...a) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: d, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  g("init", "-q", "-b", "main");
  const write = (fs_) => {
    for (const [p, t] of Object.entries(fs_)) {
      fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
      fs.writeFileSync(path.join(d, p), t);
    }
  };
  write(files);
  g("add", "-A");
  g("commit", "-qm", "base");
  return { d, g, write };
}

const tiersText = fs.readFileSync(path.join(ROOT, TIERS), "utf8");
const DS = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n';
const BASE_SCHEMA = `${DS}
model Person {
  /// @classification(internal)
  id String @id
  /// @classification(personal)
  email String
  legacyCode String?
  @@map("people")
  @@schema("app")
}
`;

// ---------------------------------------------------------------------------------------------------
// classification prisma

test("classification prisma passes a schema whose every field carries a known tier", () => {
  const r = run(["classification", "prisma", "--schema", `${FIX}/schema.prisma`, "--tiers", TIERS]);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /13 of 13 fields tagged/);
  assert.match(r.stdout, /no --base: every field is treated as new/);
});

test("classification without a tiers file exits 2 and says to create it", () => {
  const r = run(["classification", "prisma", "--schema", `${FIX}/schema.prisma`, "--tiers", `${FIX}/no-such-tiers.json`]);
  assert.equal(r.status, 2, all(r));
  assert.match(r.stderr, /no such file\. Create it in this repository/);
  const d = tmp();
  fs.copyFileSync(path.join(ROOT, FIX, "schema.prisma"), path.join(d, "schema.prisma"));
  assert.equal(run(["classification", "prisma", "--schema", "schema.prisma"], d).status, 2, "the default governance/tiers.json is missing too");
});

test("classification prisma fails an untagged NEW field and only warns on an untagged field the base already had", () => {
  const { d, g, write } = gitRepo({ "governance/tiers.json": tiersText, "prisma/schema.prisma": BASE_SCHEMA });
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("checkout", "-qb", "pr");
  write({ "prisma/schema.prisma": BASE_SCHEMA.replace("  legacyCode String?\n", "  legacyCode String?\n  phone String?\n") });
  g("commit", "-qam", "add phone");
  const r = run(["classification", "prisma", "--base", "origin/main"], d);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /Person\.phone: new field with no \/\/\/ @classification\(<tier>\)/);
  assert.match(r.stderr, /WARNING Person\.legacyCode: no classification \(it is on the base branch too/);
  assert.doesNotMatch(r.stderr, /Person\.legacyCode: new field/);
  // tagged, it passes; the old field still warns
  write({ "prisma/schema.prisma": BASE_SCHEMA.replace("  legacyCode String?\n", "  legacyCode String?\n  /// @classification(personal)\n  phone String?\n") });
  const ok = run(["classification", "prisma", "--base", "origin/main"], d);
  assert.equal(ok.status, 0, all(ok));
  assert.match(ok.stdout, /WARNING Person\.legacyCode/);
  // with no --base every field is new, so the old untagged field fails too
  assert.equal(run(["classification", "prisma"], d).status, 1);
});

test("classification prisma: an unknown tier, a malformed tag and two tags each fail", () => {
  for (const [tag, want] of [
    ["/// @classification(secret)", /tier secret is not in the tiers file/],
    ["/// @classification()", /malformed tag/],
    ["/// @classification(Personal Data)", /malformed tag/],
    ["/// @classification(personal)\n  /// @classification(internal)", /two classifications \(personal, internal\)/],
  ]) {
    const d = tmp();
    fs.mkdirSync(path.join(d, "governance"));
    fs.writeFileSync(path.join(d, "governance/tiers.json"), tiersText);
    fs.writeFileSync(path.join(d, "schema.prisma"), `${DS}\nmodel A {\n  /// @classification(internal)\n  id String @id\n  ${tag}\n  b String\n}\n`);
    const r = run(["classification", "prisma", "--schema", "schema.prisma"], d);
    assert.equal(r.status, 1, `${tag}: ${all(r)}`);
    assert.match(r.stderr, want, tag);
  }
});

test("classification prisma: a base that does not resolve exits 2; a schema the base lacks makes every field new", () => {
  const { d, g, write } = gitRepo({ "governance/tiers.json": tiersText, "README.md": "x\n" });
  write({ "prisma/schema.prisma": BASE_SCHEMA });
  assert.equal(run(["classification", "prisma", "--base", "origin/main"], d).status, 2, "origin/main does not exist");
  assert.equal(run(["classification", "prisma", "--base", "--upload-pack=x"], d).status, 2);
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  const r = run(["classification", "prisma", "--base", "origin/main"], d);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /Person\.legacyCode: new field/);
  assert.match(r.stderr, /is not on origin\/main: every field is new/);
});

test("classification prisma reads @ignore fields and @@ignore models: their columns still hold data", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "t.json"), tiersText);
  fs.writeFileSync(path.join(d, "s.prisma"), `${DS}\nmodel A {\n  /// @classification(internal)\n  id String @id\n  ssn String @ignore\n}\nmodel B {\n  id String @id\n  @@ignore\n}\n`);
  const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "t.json"], d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /A\.ssn \(@ignore\): new field/);
  assert.match(r.stderr, /B\.id: new field/);
});

test("--emit-comments writes a migration of COMMENT ON COLUMN, then nothing until a tag changes", () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX, "migrations"), path.join(d, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, FIX, "schema.prisma"), path.join(d, "schema.prisma"));
  fs.copyFileSync(path.join(ROOT, TIERS), path.join(d, "tiers.json"));
  const emit = (date) => run(["classification", "prisma", "--schema", "schema.prisma", "--tiers", "tiers.json", "--emit-comments", "migrations", "--date", date], d);
  const r = emit("2026-10-30T12:00:00Z");
  assert.equal(r.status, 0, all(r));
  const emitted = () => fs.readdirSync(path.join(d, "migrations")).filter((x) => x.endsWith("_classification_comments")).sort();
  assert.deepEqual(emitted().map((x) => x.slice(0, 8)), ["20261030"], "one migration, named for the date");
  const sql = fs.readFileSync(path.join(d, "migrations", emitted()[0], "migration.sql"), "utf8");
  assert.match(sql, /^COMMENT ON COLUMN "people"\."full_name" IS 'classification:personal';$/m, "the @map name, not the field name");
  assert.match(sql, /^COMMENT ON COLUMN "people"\."tax_id" IS 'classification:restricted';$/m);
  assert.match(sql, /^COMMENT ON COLUMN "note_embeddings"\."source_pk" IS 'classification:internal';$/m);
  assert.equal(sql.match(/^COMMENT ON COLUMN/gm).length, 13);
  const again = emit("2026-10-31T12:00:00Z");
  assert.equal(again.status, 0, all(again));
  assert.match(again.stdout, /no migration written/);
  assert.equal(emitted().length, 1, "a second run with no tag changed writes nothing");
  // one tag changes: one statement; a tag removed (still a column): IS NULL, and the check fails first
  fs.writeFileSync(path.join(d, "schema.prisma"), fs.readFileSync(path.join(d, "schema.prisma"), "utf8").replace("/// @classification(restricted)\n  taxId", "/// @classification(personal)\n  taxId"));
  const one = emit("2026-11-01T12:00:00Z");
  assert.equal(one.status, 0, all(one));
  assert.equal(emitted().length, 2);
  const sql2 = fs.readFileSync(path.join(d, "migrations", emitted()[1], "migration.sql"), "utf8");
  assert.deepEqual(sql2.match(/^COMMENT ON COLUMN.*$/gm), [`COMMENT ON COLUMN "people"."tax_id" IS 'classification:personal';`]);
});

test("--emit-comments writes nothing when the classification check fails, or the schema is not Postgres", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "migrations"));
  fs.copyFileSync(path.join(ROOT, TIERS), path.join(d, "tiers.json"));
  fs.writeFileSync(path.join(d, "s.prisma"), `${DS}\nmodel A {\n  id String @id\n}\n`);
  const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "tiers.json", "--emit-comments", "migrations"], d);
  assert.equal(r.status, 1);
  assert.deepEqual(fs.readdirSync(path.join(d, "migrations")), []);
  fs.writeFileSync(path.join(d, "m.prisma"), `datasource db {\n  provider = "mysql"\n  url = env("X")\n}\nmodel A {\n  /// @classification(internal)\n  id String @id\n}\n`);
  assert.equal(run(["classification", "prisma", "--schema", "m.prisma", "--tiers", "tiers.json", "--emit-comments", "migrations"], d).status, 2);
  assert.equal(run(["classification", "prisma", "--schema", "m.prisma", "--tiers", "tiers.json", "--emit-comments", "nope"], d).status, 2);
});

test("a malformed tiers file exits 2: unknown key, missing use rule, bad policy tag", () => {
  const d = tmp();
  fs.copyFileSync(path.join(ROOT, FIX, "schema.prisma"), path.join(d, "s.prisma"));
  const base = JSON.parse(tiersText);
  for (const mutate of [
    (t) => (t.tiers.personal["personal-data"] = true),
    (t) => delete t.tiers.personal.export,
    (t) => (t.tiers.personal.bigquery_policy_tag = "personal"),
    (t) => (t.tiers = ["public", "personal"]),
    (t) => (t.tiers.Personal = t.tiers.personal),
  ]) {
    const t = structuredClone(base);
    mutate(t);
    fs.writeFileSync(path.join(d, "t.json"), JSON.stringify(t));
    const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "t.json"], d);
    assert.equal(r.status, 2, `${mutate}: ${all(r)}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// classification dbt and emit

// The committed manifest is real `dbt parse` output (dbt-core 1.12.6, dbt-duckdb 1.11.1) of
// test/fixtures/governance/privacy/dbt/project, trimmed to the project's own nodes. A check reads it from a
// copy of the project whose every file is older than the parse, which is what a fresh `dbt parse` leaves;
// the self-test parses the project itself.
const DBT_PROJECT = `${FIX}/dbt/project`;
const CATALOG = `${FIX}/dbt/catalog.json`;
const walkFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
function dbtProject(fn) {
  const d = tmp();
  fs.cpSync(path.join(ROOT, DBT_PROJECT), d, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, "dbt", "manifest.json"), "utf8"));
  fn?.(m, d);
  const t = new Date(Date.parse(m.metadata.generated_at) - 60_000);
  for (const f of walkFiles(d)) fs.utimesSync(f, t, t);
  fs.mkdirSync(path.join(d, "target"), { recursive: true });
  const mf = path.join(d, "target", "manifest.json");
  fs.writeFileSync(mf, JSON.stringify(m));
  return { d, mf, args: ["--manifest", mf, "--repo", d] };
}
const MAN = () => dbtProject().args;
// dbt writes a column's meta both at meta and at config.meta; a tag is gone only when both are.
const untag = (c) => {
  c.meta = {};
  c.config = { ...c.config, meta: {} };
};
const retag = (c, t) => {
  c.meta = { classification: t };
  c.config = { ...c.config, meta: { classification: t } };
};
const mutatedManifest = (fn) => dbtProject(fn).args;

test("classification dbt passes tagged columns and fails an untagged one or an unknown tier", () => {
  const ok = run(["classification", "dbt", ...MAN(), "--tiers", TIERS]);
  // without --catalog, undeclared warehouse columns are NOT CHECKED: exit 2, never a pass
  assert.equal(ok.status, 2, all(ok));
  assert.match(ok.stderr, /10 column\(s\) in 4 model\(s\), snapshot\(s\) and seed\(s\)/);
  assert.match(ok.stderr, /^NOT CHECKED: a warehouse column the YAML does not declare/m);
  const full = run(["classification", "dbt", ...MAN(), "--tiers", TIERS, "--catalog", CATALOG]);
  assert.equal(full.status, 0, all(full));
  const untagged = mutatedManifest((m) => untag(m.nodes["model.privacy_fixture.dim_people"].columns.tax_id));
  const r = run(["classification", "dbt", ...untagged, "--tiers", TIERS, "--catalog", CATALOG]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dim_people\.tax_id: no meta\.classification/);
  const unknown = mutatedManifest((m) => retag(m.nodes["model.privacy_fixture.dim_people"].columns.email, "pii"));
  assert.match(run(["classification", "dbt", ...unknown, "--tiers", TIERS]).stderr, /tier pii is not in the tiers file/);
  // meta.classification (the older place) is read too
  const old = mutatedManifest((m) => {
    const c = m.nodes["model.privacy_fixture.dim_people"].columns.email;
    c.meta = { classification: "personal" };
    c.config = {};
  });
  assert.equal(run(["classification", "dbt", ...old, "--tiers", TIERS, "--catalog", CATALOG]).status, 0);
});

test("classification dbt: --path that matches no model exits 2; with --catalog an undeclared warehouse column fails", () => {
  assert.equal(run(["classification", "dbt", ...MAN(), "--tiers", TIERS, "--path", "models/mart/"]).status, 2);
  const one = run(["classification", "dbt", ...MAN(), "--tiers", TIERS, "--path", "models/marts/", "--catalog", CATALOG]);
  assert.equal(one.status, 0, all(one));
  assert.match(one.stdout, /in 1 model\(s\)/);
  const d = tmp();
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, CATALOG), "utf8"));
  cat.nodes["model.privacy_fixture.dim_people"].columns.PHONE = { name: "PHONE" };
  fs.writeFileSync(path.join(d, "catalog.json"), JSON.stringify(cat));
  const r = run(["classification", "dbt", ...MAN(), "--tiers", TIERS, "--catalog", path.join(d, "catalog.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dim_people\.PHONE: in the warehouse, not declared in the YAML/);
});

test("classification emit snowflake writes one SET TAG per column, ALTER VIEW for a view, and nothing when a column is untagged", () => {
  const r = run(["classification", "emit", "snowflake", ...MAN(), "--tiers", TIERS, "--tag", "GOVERNANCE.TAGS.CLASSIFICATION"]);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /^CREATE TAG IF NOT EXISTS GOVERNANCE\.TAGS\.CLASSIFICATION ALLOWED_VALUES 'public', 'internal', 'personal', 'restricted';$/m);
  assert.match(r.stdout, /^ALTER TABLE "PRIV"\."MAIN"\."DIM_PEOPLE" MODIFY COLUMN "TAX_ID" SET TAG GOVERNANCE\.TAGS\.CLASSIFICATION = 'restricted';$/m);
  assert.match(r.stdout, /^ALTER VIEW "PRIV"\."MAIN"\."STG_PEOPLE" MODIFY COLUMN "EMAIL" SET TAG GOVERNANCE\.TAGS\.CLASSIFICATION = 'personal';$/m);
  assert.match(r.stdout, /^ALTER TABLE "PRIV"\."MAIN"\."PEOPLE_HISTORY" MODIFY COLUMN "EMAIL" SET TAG/m, "a snapshot is tagged too");
  assert.match(r.stdout, /^ALTER TAG GOVERNANCE\.TAGS\.CLASSIFICATION ADD ALLOWED_VALUES 'restricted';$/m, "a tier added after the tag exists is added to it");
  const untagged = mutatedManifest((m) => untag(m.nodes["model.privacy_fixture.stg_people"].columns.email));
  const bad = run(["classification", "emit", "snowflake", ...untagged, "--tiers", TIERS, "--tag", "GOVERNANCE.TAGS.CLASSIFICATION"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(run(["classification", "emit", "snowflake", ...MAN(), "--tiers", TIERS, "--tag", "x; drop table y"]).status, 2);
});

test("classification emit bigquery merges policy tags into the current schema, clears them for a tier with none, and needs the current schema", () => {
  const d = tmp();
  const current = [
    { name: "person_id", type: "STRING", mode: "REQUIRED", policyTags: { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/9999"] } },
    { name: "email", type: "STRING", mode: "NULLABLE", description: "kept" },
    { name: "tax_id", type: "STRING", mode: "NULLABLE" },
  ];
  fs.writeFileSync(path.join(d, "cur.json"), JSON.stringify(current));
  const r = run(["classification", "emit", "bigquery", ...MAN(), "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(r.status, 0, all(r));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out[0], { name: "person_id", type: "STRING", mode: "REQUIRED", policyTags: { names: [] } });
  assert.deepEqual(out[1], { name: "email", type: "STRING", mode: "NULLABLE", description: "kept", policyTags: { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/2222"] } });
  assert.deepEqual(out[2].policyTags, { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/3333"] });
  assert.equal(run(["classification", "emit", "bigquery", ...MAN(), "--tiers", TIERS, "--model", "dim_people"]).status, 2);
  fs.writeFileSync(path.join(d, "extra.json"), JSON.stringify([...current, { name: "phone", type: "STRING" }]));
  const extra = run(["classification", "emit", "bigquery", ...MAN(), "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "extra.json")]);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /dim_people\.phone: no meta\.classification/);
  const t = JSON.parse(tiersText);
  delete t.tiers.personal.bigquery_policy_tag;
  fs.writeFileSync(path.join(d, "t.json"), JSON.stringify(t));
  const noTag = run(["classification", "emit", "bigquery", ...MAN(), "--tiers", path.join(d, "t.json"), "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(noTag.status, 1);
  assert.match(noTag.stderr, /tier personal: no bigquery_policy_tag/);
});

// ---------------------------------------------------------------------------------------------------
// deletion-map

const dm = (map, extra = []) => run(["deletion-map", "--map", map, "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS, ...extra]);
const dmFull = (map) => dm(map, [...MAN()]);
function mapWith(fn) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, "deletion-map.json"), "utf8"));
  fn(m);
  const f = path.join(tmp(), "map.json");
  fs.writeFileSync(f, JSON.stringify(m));
  return f;
}

test("deletion-map passes a map that holds every personal store, and says what it could not check", () => {
  const r = dm(`${FIX}/deletion-map.json`);
  assert.equal(r.status, 2, `an entry it could not check is NOT CHECKED, never a pass: ${all(r)}`);
  assert.match(r.stderr, /NOT CHECKED: stores\[2\] \(warehouse copy\) holds dbt:dim_people, and no --manifest was given/);
  const both = dm(`${FIX}/deletion-map.json`, [...MAN()]);
  assert.equal(both.status, 0, all(both));
  const narrow = dm(mapWith((m) => (m.stores[2].holds = ["dbt:dim_people"])), [...MAN()]);
  assert.equal(narrow.status, 1, "with the manifest, stg_people holds personal data and is on no store");
  assert.match(narrow.stderr, /dbt:stg_people holds personal data/);
  assert.match(narrow.stderr, /dbt:people_history holds personal data/, "a snapshot is a personal-data store");
});

test("deletion-map fails when the embeddings are missing from the map", () => {
  const r = dmFull(`${FIX}/deletion-map-no-embeddings.json`);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /prisma:NoteEmbedding holds personal data .* and no store on the map holds it/);
  assert.match(r.stderr, /prisma:NoteEmbedding has a vector column and is not on the map as an embedding store/);
  // on the map, but as the wrong kind of store
  const wrongKind = mapWith((m) => (m.stores[1].kind = "primary"));
  const w = dmFull(wrongKind);
  assert.equal(w.status, 1);
  assert.match(w.stderr, /has a vector column and is not on the map as an embedding store/);
});

test("deletion-map: backups must state their window and the restore choice; entries need a delete path; stale entries fail", () => {
  for (const [fn, want] of [
    [(m) => (m.stores = m.stores.filter((s) => s.kind !== "backup")), /no backup store; state the backup window/],
    [(m) => delete m.stores[3].after_restore, /after_restore: "reapply"/],
    [(m) => delete m.stores[3].retention_days, /a backup states retention_days/],
    [(m) => (m.stores[0].delete = ""), /no "delete"/],
    [(m) => m.stores[0].holds.push("prisma:Ghost"), /holds prisma:Ghost, which the schema does not have/],
    [(m) => m.stores[0].holds.push("Person"), /want prisma:<Model>, dbt:<model> or all/],
  ]) {
    const r = dmFull(mapWith(fn));
    assert.equal(r.status, 1, `${fn}: ${all(r)}`);
    assert.match(r.stderr, want);
  }
  assert.equal(run(["deletion-map", "--map", `${FIX}/deletion-map.json`, "--tiers", TIERS]).status, 2, "no source");
  assert.equal(run(["deletion-map", "--map", `${FIX}/nope.json`, "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS]).status, 2);
});

// ---------------------------------------------------------------------------------------------------
// retention

test("retention passes rules whose jobs exist and fails a rule pointing at a job that does not", () => {
  const ok = run(["retention", "--rules", `${FIX}/retention.json`, "--tiers", TIERS]);
  assert.equal(ok.status, 0, all(ok));
  const r = run(["retention", "--rules", `${FIX}/retention-missing-job.json`, "--tiers", TIERS]);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /scheduler\.tf does not mention purge-old-sessions; the enforcement it names does not exist there/);
});

test("retention: a policy with no job, a job with no test, a tier with no rule and a rule that keeps too long each fail", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, "retention.json"), "utf8"));
  for (const [fn, want] of [
    [(j) => delete j.rules[0].enforcement, /a policy with no job is not retention/],
    [(j) => (j.rules[0].enforcement.kind = "policy"), /enforcement\.kind must be one of/],
    [(j) => delete j.rules[0].test, /a scheduled delete needs a test/],
    [(j) => (j.rules[0].enforcement.file = "../outside.tf"), /want a relative path inside the repository/],
    [(j) => (j.rules[0].enforcement.kind = "lifecycle-rule"), /no google_storage_bucket named purge-sessions with a Delete lifecycle rule/],
    [(j) => (j.rules = j.rules.filter((r) => r.tier !== "restricted")), /tier restricted keeps data 30 days, and no rule enforces it/],
    [(j) => (j.rules[0].keep_days = 90), /keeps restricted 90 days; the tier allows 30/],
  ]) {
    const j = structuredClone(base);
    fn(j);
    const f = path.join(tmp(), "r.json");
    fs.writeFileSync(f, JSON.stringify(j));
    const r = run(["retention", "--rules", f, "--tiers", TIERS]);
    assert.equal(r.status, 1, `${fn}: ${all(r)}`);
    assert.match(r.stderr, want);
  }
  assert.equal(run(["retention", "--rules", `${FIX}/nope.json`]).status, 2);
});

test("retention with no tiers file is NOT CHECKED (exit 2), never a pass", () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX), path.join(d, FIX), { recursive: true });
  const r = run(["retention", "--rules", `${FIX}/retention.json`], d);
  assert.equal(r.status, 2, all(r));
  assert.match(r.stderr, /NOT CHECKED: no governance\/tiers\.json/);
});

// ---------------------------------------------------------------------------------------------------
// exports

const ex = (extra) => run(["exports", "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS, ...extra]);

test("exports: a masked or waived column passes; an unmasked restricted one warns, and fails with --strict", () => {
  const ok = ex(["--module", `${FIX}/src/export/people.ts`]);
  assert.equal(ok.status, 0, all(ok));
  assert.match(ok.stdout, /no unmasked export of a guarded column/);
  const warn = ex(["--module", `${FIX}/src/export/**/*.ts`]);
  assert.equal(warn.status, 0, all(warn));
  assert.match(warn.stdout, /WARNING test\/fixtures\/governance\/privacy\/src\/export\/sessions\.ts:2: token \(prisma:Session, tier restricted, export deny\) is in an export/);
  assert.doesNotMatch(warn.stdout, /people\.ts/);
  const strict = ex(["--module", `${FIX}/src/export/**/*.ts`, "--strict", "true"]);
  assert.equal(strict.status, 1);
});

test("exports: a waiver with no reason fails, and a module glob that matches nothing exits 2", () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX), path.join(d, FIX), { recursive: true });
  const f = path.join(d, FIX, "src/export/people.ts");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/governance: export-ok .*$/m, "governance: export-ok"));
  const r = run(["exports", "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS, "--module", `${FIX}/src/export/people.ts`], d);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /a waiver needs a reason/);
  assert.equal(ex(["--module", `${FIX}/src/exports/*.ts`]).status, 2);
  assert.equal(ex([]).status, 2);
});

test("exports: an unmasked personal column (export: mask) warns", () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX), path.join(d, FIX), { recursive: true });
  const f = path.join(d, FIX, "src/export/people.ts");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("email: mask(p.email)", "email: p.email"));
  const r = run(["exports", "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS, "--module", `${FIX}/src/export/people.ts`], d);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /people\.ts:6: email \(prisma:Person, tier personal, export mask\) is exported with no mask call/);
});

// ---------------------------------------------------------------------------------------------------
// evidence append --from

test("evidence append --from appends every entry in order and refuses a malformed one", () => {
  const d = tmp();
  const entries = [
    { check: "governance:data-privacy/classification", date: "2026-10-30T00:00:00.000Z", result: "pass", run_link: null, commit: "abc", detail: "exit 0" },
    { check: "governance:data-privacy/retention", date: "2026-10-30T00:00:01.000Z", result: "fail", run_link: "https://example.test/r/1", commit: "abc", detail: "exit 1" },
  ];
  fs.writeFileSync(path.join(d, "new.json"), JSON.stringify(entries));
  fs.writeFileSync(path.join(d, "ev.json"), JSON.stringify([{ check: "old", date: "2026-01-01T00:00:00Z", result: "pass", run_link: null, commit: "x", detail: "" }]));
  const r = run(["evidence", "append", "--from", "new.json", "--file", "ev.json"], d);
  assert.equal(r.status, 0, all(r));
  const after = JSON.parse(fs.readFileSync(path.join(d, "ev.json"), "utf8"));
  assert.equal(after.length, 3);
  assert.equal(after[0].check, "old");
  assert.deepEqual(after.slice(1), entries);
  fs.writeFileSync(path.join(d, "bad.json"), JSON.stringify([{ ...entries[0], result: "compliant" }]));
  assert.equal(run(["evidence", "append", "--from", "bad.json", "--file", "ev.json"], d).status, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "ev.json"), "utf8")).length, 3, "a refused --from writes nothing");
  assert.equal(run(["evidence", "append", "--from", "new.json", "--check", "x", "--result", "pass"], d).status, 2);
});

// ---------------------------------------------------------------------------------------------------
// gates#11 review, round 1. Each case below passed the code under review (cd243641) and fails it now.

const inDir = (files) => {
  const d = tmp();
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), t);
  }
  fs.copyFileSync(path.join(ROOT, TIERS), path.join(d, "tiers.json"));
  return d;
};

// finding 1: the result is the check's own status. A NOT CHECKED line is not_run whatever the exit code.
test("finding 1: a check that prints NOT CHECKED exits 2 and its status is not_run", async () => {
  const { checkStatus } = await import("../scripts/governance-check.mjs");
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX), path.join(d, FIX), { recursive: true });
  const cwd = process.cwd();
  process.chdir(d);
  try {
    const r = checkStatus(["retention", "--rules", `${FIX}/retention.json`]);
    assert.equal(r.status, "not_run");
    assert.equal(r.code, 2);
  } finally {
    process.chdir(cwd);
  }
  const statusFile = path.join(tmp(), "status");
  const r = spawnSync(process.execPath, [SCRIPT, "retention", "--rules", `${FIX}/retention.json`], { cwd: d, encoding: "utf8", env: { ...process.env, GOVERNANCE_STATUS_FILE: statusFile } });
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(statusFile, "utf8").trim(), "not_run");
});

test("finding 1: the runner records not_run for a NOT CHECKED check that exits 0", { skip: process.platform === "win32" && "bash" }, () => {
  const d = tmp();
  // A stand-in governance-check that prints NOT CHECKED, writes not_run and exits 0.
  const gc = path.join(d, "gc.mjs");
  fs.writeFileSync(gc, `import fs from "node:fs";\nif (process.argv[2] === "evidence") { const f = process.env.GOVERNANCE_EVIDENCE_FILE; const a = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : []; a.push({ result: process.argv[process.argv.indexOf("--result") + 1] }); fs.writeFileSync(f, JSON.stringify(a)); }\nelse { console.log("NOT CHECKED: something"); if (process.env.GOVERNANCE_STATUS_FILE) fs.writeFileSync(process.env.GOVERNANCE_STATUS_FILE, "not_run\\n"); }\n`);
  const evidence = path.join(d, "e.json");
  const env = { ...process.env, CHECKS: "t:a/x=anything", GC: gc, GOVERNANCE_EVIDENCE_FILE: evidence };
  delete env.BASH_ENV;
  delete env.ENV;
  const r = spawnSync("bash", [path.join(ROOT, "scripts", "run-governance-checks.sh")], { cwd: d, env, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, "utf8")).map((e) => e.result), ["not_run"]);
  // And with no status written at all, an exit 0 is still not a pass.
  fs.writeFileSync(gc, fs.readFileSync(gc, "utf8").replace(/if \(process\.env\.GOVERNANCE_STATUS_FILE\)[^}]*;/, ""));
  fs.rmSync(evidence);
  const r2 = spawnSync("bash", [path.join(ROOT, "scripts", "run-governance-checks.sh")], { cwd: d, env, encoding: "utf8" });
  assert.equal(r2.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, "utf8")).map((e) => e.result), ["not_run"]);
});

// finding 2: retention accepts only a real, enabled job that deletes, and a real test of it.
test("finding 2: retention refuses a README TODO, a paused job, a suspended CronJob and a test that is not one", () => {
  const rules = (enf, test = "tests/purge.test.ts", extra = {}) => JSON.stringify({ rules: [{ name: "sessions", keep_days: 30, enforcement: { kind: "scheduled-job", id: "purge-sessions", ...enf }, test, ...extra }] });
  const realTest = 'import { test } from "vitest";\ntest("purge-sessions deletes a session 30 days old", () => {});\n';
  const tf = (body) => `resource "google_cloud_scheduler_job" "purge" {\n  name     = "purge-sessions"\n  schedule = "0 3 * * *"\n${body}  http_target {\n    uri = "https://run.googleapis.com/v2/projects/p/locations/l/jobs/purge-sessions:run"\n  }\n}\n`;
  const check = (files) => run(["retention", "--rules", "r.json", "--tiers", "tiers.json"], inDir(files));
  // the real thing passes
  const ok = check({ "r.json": rules({ file: "infra/jobs.tf" }), "infra/jobs.tf": tf(""), "tests/purge.test.ts": realTest });
  assert.equal(ok.status, 1, all(ok)); // the fixture tiers want rules for every tier with retention_days
  assert.doesNotMatch(ok.stderr, /rules\[0\]/, all(ok));
  for (const [files, want] of [
    [{ "r.json": rules({ file: "infra/README.md" }), "infra/README.md": "# Retention TODO: write a cron job purge-sessions that deletes sessions after 30 days\n", "tests/purge.test.ts": realTest }, /no scheduled job named purge-sessions/],
    [{ "r.json": rules({ file: "infra/jobs.tf" }), "infra/jobs.tf": tf("  paused   = true\n"), "tests/purge.test.ts": realTest }, /is paused/],
    [{ "r.json": rules({ file: "infra/jobs.tf" }), "infra/jobs.tf": `# ${tf("").split("\n").join("\n# ")}`, "tests/purge.test.ts": realTest }, /no scheduled job named purge-sessions/],
    [{ "r.json": rules({ file: "k8s/purge.yaml" }), "k8s/purge.yaml": "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: purge-sessions\nspec:\n  suspend: true\n  schedule: \"0 3 * * *\"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - name: purge\n              command: [\"node\", \"purge.js\", \"--delete-older-than\", \"30d\"]\n", "tests/purge.test.ts": realTest }, /is suspended/],
    [{ "r.json": rules({ file: "infra/jobs.tf" }, "tests/anything.txt"), "infra/jobs.tf": tf(""), "tests/anything.txt": "x\n" }, /is not a test file by its name/],
    [{ "r.json": rules({ file: "infra/jobs.tf" }), "infra/jobs.tf": tf(""), "tests/purge.test.ts": "// nothing here\n" }, /holds no test or assertion/],
    [{ "r.json": rules({ file: "infra/jobs.tf" }), "infra/jobs.tf": tf(""), "tests/purge.test.ts": 'import { test } from "vitest";\ntest("something else", () => {});\n' }, /names neither the job purge-sessions/],
  ]) {
    const r = check(files);
    assert.equal(r.status, 1, all(r));
    assert.match(r.stderr, want);
  }
  // an enabled CronJob that deletes, with a test that names it, is enforcement
  const cron = check({ "r.json": rules({ file: "k8s/purge.yaml" }), "k8s/purge.yaml": "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: purge-sessions\nspec:\n  schedule: \"0 3 * * *\"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - name: purge\n              command: [\"node\", \"purge.js\", \"--delete-older-than\", \"30d\"]\n", "tests/purge.test.ts": realTest });
  assert.doesNotMatch(cron.stderr, /rules\[0\]/, all(cron));
});

// finding 3: a changed untagged field writes a different column, so it fails like a new one.
test("finding 3: a type change, an @map retarget or a @db change on an untagged field fails", () => {
  const base = `${DS}\nmodel Person {\n  /// @classification(internal)\n  id String @id\n  notes String\n  nickname String\n  code String @db.VarChar(10)\n  label String\n}\n`;
  for (const [from, to, want] of [
    ["notes String", "notes Json", /Person\.notes: changed \(notes String on the base, notes Json now\)/],
    ["nickname String", 'nickname String @map("ssn")', /Person\.nickname: changed \(nickname String on the base, ssn String now\)/],
    ["code String @db.VarChar(10)", "code String @db.Text", /Person\.code: changed/],
  ]) {
    const { d, write } = gitRepo({ "s.prisma": base, "t.json": tiersText });
    write({ "s.prisma": base.replace(from, to) });
    const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "t.json", "--base", "main"], d);
    assert.equal(r.status, 1, all(r));
    assert.match(r.stderr, want);
  }
  // only making it optional changes no column: still a warning
  const { d, write } = gitRepo({ "s.prisma": base, "t.json": tiersText });
  write({ "s.prisma": base.replace("label String", "label String?") });
  const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "t.json", "--base", "main"], d);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /WARNING Person\.label: no classification/);
});

// finding 4: --schema prisma/schema.prisma reads the other files of a multi-file schema.
test("finding 4: a file of a multi-file schema brings its folder; a sibling with its own datasource does not", () => {
  const main = `${DS}\nmodel User {\n  /// @classification(internal)\n  id String @id\n}\n`;
  const d = inDir({ "prisma/schema.prisma": main, "prisma/payments.prisma": "model Card {\n  /// @classification(internal)\n  id String @id\n  pan String\n}\n", "prisma/other/legacy.prisma": `${DS}\nmodel Old {\n  id String @id\n}\n` });
  const r = run(["classification", "prisma", "--schema", "prisma/schema.prisma", "--tiers", "tiers.json"], d);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /Card\.pan: new field/);
  assert.doesNotMatch(r.stderr, /Old\.id/, "a file with its own datasource is a different schema");
  // the base reads the same files: an old untagged field in the sibling only warns
  const g = gitRepo({ "prisma/schema.prisma": main, "prisma/payments.prisma": "model Card {\n  /// @classification(internal)\n  id String @id\n  pan String\n}\n", "t.json": tiersText });
  const b = run(["classification", "prisma", "--schema", "prisma/schema.prisma", "--tiers", "t.json", "--base", "main"], g.d);
  assert.equal(b.status, 0, all(b));
  assert.match(b.stdout, /WARNING Card\.pan/);
});

// finding 11d: a `//` line or a blank line detaches a `///` tag from the field below it.
test("finding 11d: a tag separated from its field by a // line and a blank line does not tag it", () => {
  const d = inDir({ "s.prisma": `${DS}\nmodel A {\n  /// @classification(internal)\n  id String @id\n  /// @classification(public)\n  // ssn below\n\n  ssn String\n}\n` });
  const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "tiers.json"], d);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /A\.ssn: new field/);
});

// finding 5: a column dropped and added back after its comment was set gets the comment again.
test("finding 5: --emit-comments writes the comment again for a column a later migration dropped and re-added", () => {
  const schema = `${DS}\nmodel Person {\n  /// @classification(internal)\n  id String @id\n  /// @classification(personal)\n  phone String\n  @@map("Person Data")\n  @@schema("app")\n}\n`;
  const d = inDir({
    "s.prisma": schema,
    "migrations/0001_init/migration.sql": 'CREATE TABLE "app"."Person Data" ("id" TEXT NOT NULL, "phone" TEXT NOT NULL);\n',
    "migrations/0002_classification_comments/migration.sql": `COMMENT ON COLUMN "app"."Person Data"."id" IS 'classification:internal';\nCOMMENT ON COLUMN "app"."Person Data"."phone" IS 'classification:personal';\n`,
    "migrations/0003_drop_phone/migration.sql": '-- AlterTable\nALTER TABLE "app"."Person Data" DROP COLUMN "phone";\n',
    "migrations/0004_add_phone/migration.sql": '-- AlterTable\nALTER TABLE "app"."Person Data" ADD COLUMN "phone" TEXT NOT NULL;\n',
  });
  const r = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "tiers.json", "--emit-comments", "migrations", "--date", "2026-11-01T00:00:00Z"], d);
  assert.equal(r.status, 0, all(r));
  const sql = fs.readFileSync(path.join(d, "migrations", `${"20261101"}000000_classification_comments`, "migration.sql"), "utf8");
  assert.deepEqual(sql.match(/^COMMENT ON COLUMN.*$/gm), [`COMMENT ON COLUMN "app"."Person Data"."phone" IS 'classification:personal';`]);
  // a table dropped and created again loses every comment
  fs.mkdirSync(path.join(d, "migrations", `${"20261102"}000000_recreate`));
  fs.writeFileSync(path.join(d, "migrations", `${"20261102"}000000_recreate`, "migration.sql"), 'DROP TABLE "app"."Person Data";\nCREATE TABLE "app"."Person Data" ("id" TEXT NOT NULL, "phone" TEXT NOT NULL);\n');
  const again = run(["classification", "prisma", "--schema", "s.prisma", "--tiers", "tiers.json", "--emit-comments", "migrations", "--date", "2026-11-03T00:00:00Z"], d);
  assert.equal(again.status, 0, all(again));
  assert.equal(fs.readFileSync(path.join(d, "migrations", `${"20261103"}000000_classification_comments`, "migration.sql"), "utf8").match(/^COMMENT ON COLUMN/gm).length, 2);
});

// finding 6: a stale manifest is refused; snapshots and seeds are classified.
test("finding 6: classification dbt refuses a stale or unversioned manifest and reads snapshots and seeds", () => {
  const stale = dbtProject((m, d) => {
    m.metadata.generated_at = "2019-01-01T00:00:00Z";
  });
  const later = new Date();
  for (const f of walkFiles(stale.d)) if (!f.includes(`${path.sep}target${path.sep}`)) fs.utimesSync(f, later, later);
  const r = run(["classification", "dbt", ...stale.args, "--tiers", TIERS, "--catalog", CATALOG]);
  assert.equal(r.status, 2, all(r));
  assert.match(r.stderr, /is not a current parse \(run dbt parse\)/);
  const noVersion = mutatedManifest((m) => delete m.metadata.dbt_schema_version);
  assert.match(run(["classification", "dbt", ...noVersion, "--tiers", TIERS, "--catalog", CATALOG]).stderr, /not a dbt manifest \(no metadata\.dbt_schema_version\)/);
  const elsewhere = run(["classification", "dbt", "--manifest", path.join(ROOT, FIX, "dbt", "manifest.json"), "--repo", tmp(), "--tiers", TIERS, "--catalog", CATALOG]);
  assert.equal(elsewhere.status, 2);
  assert.match(elsewhere.stderr, /holds no dbt project of that name/);
  for (const id of ["snapshot.privacy_fixture.people_history", "seed.privacy_fixture.people_seed"]) {
    const args = mutatedManifest((m) => untag(m.nodes[id].columns.email));
    const u = run(["classification", "dbt", ...args, "--tiers", TIERS, "--catalog", CATALOG]);
    assert.equal(u.status, 1, all(u));
    assert.match(u.stderr, new RegExp(`${id.replace(/\./g, "\\.")}\\.email: no meta\\.classification`));
  }
});

// finding 7: embeddings in Float[] or Bytes are personal-data stores; an untagged new model is NOT CHECKED.
test("finding 7: deletion-map needs Float[] and Bytes embedding columns on the map, and an untagged column is NOT CHECKED", () => {
  const map = JSON.stringify({ stores: [{ name: "db", kind: "primary", holds: ["prisma:Person"], delete: "src/delete.ts" }, { name: "backups", kind: "backup", holds: ["all"], delete: "expire", retention_days: 7, after_restore: "expire" }] });
  const person = "model Person {\n  /// @classification(internal)\n  id String @id\n  /// @classification(personal)\n  email String\n}\n";
  for (const col of ["embedding Float[]", "embedding Bytes", 'vec Unsupported("halfvec(3)")']) {
    const d = inDir({ "s.prisma": `${DS}\n${person}model NoteChunk {\n  /// @classification(internal)\n  id String @id\n  /// @classification(internal)\n  ${col}\n}\n`, "map.json": map });
    const r = run(["deletion-map", "--map", "map.json", "--prisma", "s.prisma", "--tiers", "tiers.json"], d);
    assert.equal(r.status, 1, `${col}: ${all(r)}`);
    assert.match(r.stderr, /prisma:NoteChunk holds personal data \(\w+ \(embedding\)\) and no store on the map holds it/);
  }
  // a Float[] that is not named as an embedding is just a list of numbers
  const plain = inDir({ "s.prisma": `${DS}\n${person}model Reading {\n  /// @classification(internal)\n  id String @id\n  /// @classification(internal)\n  samples Float[]\n}\n`, "map.json": map });
  assert.equal(run(["deletion-map", "--map", "map.json", "--prisma", "s.prisma", "--tiers", "tiers.json"], plain).status, 0);
  const untagged = inDir({ "s.prisma": `${DS}\n${person}model SupportTicket {\n  id String @id\n  body String\n  email String\n}\n`, "map.json": map });
  const u = run(["deletion-map", "--map", "map.json", "--prisma", "s.prisma", "--tiers", "tiers.json"], untagged);
  assert.equal(u.status, 2, all(u));
  assert.match(u.stderr, /NOT CHECKED: 3 untagged column\(s\)/);
});

// finding 8: whole-row exports, a waiver that leaked to the next line, and two-letter columns.
test("finding 8: exports sees whole-row reads and writes, waives one line only, and guards a two-letter column", () => {
  const schema = `${DS}\nmodel Person {\n  /// @classification(internal)\n  id String @id\n  /// @classification(restricted)\n  ssn String\n  /// @classification(personal)\n  email String\n  /// @classification(personal)\n  ip String\n}\n`;
  const mod = [
    "export async function dump(prisma) {",
    "  const rows = await prisma.person.findMany();",
    "  const one = await prisma.person.findFirst({ where: { id: '1' }, select: { id: true } });",
    "  const a = rows.map((r) => Object.values(r));",
    "  const b = rows.map((p) => ({ ...p }));",
    "  const c = rows.map((p) => JSON.stringify(p));",
    "  const list = [...rows];",
    "  const w = rows[0].email; // governance: export-ok the partner contract needs it",
    "  const leak = rows[0].ssn;",
    "  const addr = rows[0].ip;",
    "  return [a, b, c, w, leak, addr, one, list];",
    "}",
  ].join("\n");
  const d = inDir({ "s.prisma": schema, "src/export/dump.ts": mod });
  const r = run(["exports", "--module", "src/export/*.ts", "--prisma", "s.prisma", "--tiers", "tiers.json"], d);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /dump\.ts:2: whole-row read \(person\.findMany with no select\)/);
  assert.doesNotMatch(r.stdout, /dump\.ts:3:/, "a find with a select is not a whole row");
  assert.match(r.stdout, /dump\.ts:4: whole-row export \(Object\.values/);
  assert.match(r.stdout, /dump\.ts:5: whole-row export \(an object spread/);
  assert.match(r.stdout, /dump\.ts:6: whole-row export \(JSON\.stringify/);
  assert.doesNotMatch(r.stdout, /dump\.ts:7:/, "an array spread copies a list, not a row");
  assert.doesNotMatch(r.stdout, /dump\.ts:8:/, "the waived line");
  assert.match(r.stdout, /dump\.ts:9: ssn .* is in an export/, "a trailing waiver does not cover the next line");
  assert.match(r.stdout, /dump\.ts:10: ip \(prisma:Person, tier personal/);
  assert.equal(run(["exports", "--module", "src/export/*.ts", "--prisma", "s.prisma", "--tiers", "tiers.json", "--strict", "true"], d).status, 1);
});

// finding 9: Snowflake identifiers are quoted: a reserved word, and a `quote: true` column keeps its case.
test("finding 9: emit snowflake quotes a reserved column and keeps a quoted column's case", () => {
  const args = mutatedManifest((m) => {
    const cols = m.nodes["model.privacy_fixture.dim_people"].columns;
    cols.order = { name: "order", config: { meta: { classification: "internal" } } };
    cols.HomeAddress = { name: "HomeAddress", quote: true, config: { meta: { classification: "personal" } } };
  });
  const r = run(["classification", "emit", "snowflake", ...args, "--tiers", TIERS, "--tag", "GOVERNANCE.TAGS.CLASSIFICATION", "--model", "dim_people"]);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /MODIFY COLUMN "ORDER" SET TAG/);
  assert.match(r.stdout, /MODIFY COLUMN "HomeAddress" SET TAG/);
  assert.doesNotMatch(r.stdout, /MODIFY COLUMN (order|HomeAddress) /);
});

// finding 10: BigQuery RECORD columns: the leaves get the tags, the record none.
test("finding 10: emit bigquery tags the leaves of a RECORD, from the leaf or its declared parent", () => {
  const d = tmp();
  const current = [
    { name: "person_id", type: "STRING", mode: "REQUIRED" },
    { name: "email", type: "STRING" },
    { name: "tax_id", type: "STRING" },
    { name: "address", type: "RECORD", fields: [{ name: "street", type: "STRING" }, { name: "zip", type: "STRING" }] },
  ];
  fs.writeFileSync(path.join(d, "cur.json"), JSON.stringify(current));
  const args = mutatedManifest((m) => {
    m.nodes["model.privacy_fixture.dim_people"].columns["address.street"] = { name: "address.street", config: { meta: { classification: "personal" } } };
    m.nodes["model.privacy_fixture.dim_people"].columns["address.zip"] = { name: "address.zip", config: { meta: { classification: "internal" } } };
  });
  const r = run(["classification", "emit", "bigquery", ...args, "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(r.status, 0, all(r));
  const out = JSON.parse(r.stdout);
  assert.equal(out[3].policyTags, undefined, "a RECORD carries no policy tag");
  assert.deepEqual(out[3].fields[0].policyTags, { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/2222"] });
  assert.deepEqual(out[3].fields[1].policyTags, { names: [] });
  const parent = mutatedManifest((m) => (m.nodes["model.privacy_fixture.dim_people"].columns.address = { name: "address", config: { meta: { classification: "personal" } } }));
  const p = run(["classification", "emit", "bigquery", ...parent, "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(p.status, 0, all(p));
  assert.deepEqual(JSON.parse(p.stdout)[3].fields[1].policyTags, { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/2222"] });
});
