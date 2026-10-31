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

const MANIFEST = `${FIX}/dbt/manifest.json`;
function mutatedManifest(fn) {
  const d = tmp();
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8"));
  fn(m);
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(m));
  return path.join(d, "manifest.json");
}

test("classification dbt passes tagged columns and fails an untagged one or an unknown tier", () => {
  const ok = run(["classification", "dbt", "--manifest", MANIFEST, "--tiers", TIERS]);
  assert.equal(ok.status, 0, all(ok));
  assert.match(ok.stdout, /5 column\(s\) in 2 model\(s\)/);
  assert.match(ok.stdout, /NOT CHECKED \(pass --catalog\)/);
  const untagged = mutatedManifest((m) => delete m.nodes["model.privacy_fixture.dim_people"].columns.tax_id.config.meta.classification);
  const r = run(["classification", "dbt", "--manifest", untagged, "--tiers", TIERS]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dim_people\.tax_id: no meta\.classification/);
  const unknown = mutatedManifest((m) => (m.nodes["model.privacy_fixture.dim_people"].columns.email.config.meta.classification = "pii"));
  assert.match(run(["classification", "dbt", "--manifest", unknown, "--tiers", TIERS]).stderr, /tier pii is not in the tiers file/);
  // meta.classification (the older place) is read too
  const old = mutatedManifest((m) => {
    const c = m.nodes["model.privacy_fixture.dim_people"].columns.email;
    c.meta = { classification: "personal" };
    c.config = {};
  });
  assert.equal(run(["classification", "dbt", "--manifest", old, "--tiers", TIERS]).status, 0);
});

test("classification dbt: --path that matches no model exits 2; with --catalog an undeclared warehouse column fails", () => {
  assert.equal(run(["classification", "dbt", "--manifest", MANIFEST, "--tiers", TIERS, "--path", "models/mart/"]).status, 2);
  const one = run(["classification", "dbt", "--manifest", MANIFEST, "--tiers", TIERS, "--path", "models/marts/"]);
  assert.equal(one.status, 0, all(one));
  assert.match(one.stdout, /in 1 model\(s\)/);
  const d = tmp();
  const cat = { nodes: { "model.privacy_fixture.dim_people": { columns: { PERSON_ID: { name: "PERSON_ID" }, EMAIL: { name: "EMAIL" }, TAX_ID: { name: "TAX_ID" }, PHONE: { name: "PHONE" } } }, "model.privacy_fixture.stg_people": { columns: { PERSON_ID: { name: "PERSON_ID" }, EMAIL: { name: "EMAIL" } } } } };
  fs.writeFileSync(path.join(d, "catalog.json"), JSON.stringify(cat));
  const r = run(["classification", "dbt", "--manifest", MANIFEST, "--tiers", TIERS, "--catalog", path.join(d, "catalog.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dim_people\.PHONE: in the warehouse, not declared in the YAML/);
});

test("classification emit snowflake writes one SET TAG per column, ALTER VIEW for a view, and nothing when a column is untagged", () => {
  const r = run(["classification", "emit", "snowflake", "--manifest", MANIFEST, "--tiers", TIERS, "--tag", "GOVERNANCE.TAGS.CLASSIFICATION"]);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /^CREATE TAG IF NOT EXISTS GOVERNANCE\.TAGS\.CLASSIFICATION ALLOWED_VALUES 'public', 'internal', 'personal', 'restricted';$/m);
  assert.match(r.stdout, /^ALTER TABLE ANALYTICS\.MARTS\.dim_people MODIFY COLUMN tax_id SET TAG GOVERNANCE\.TAGS\.CLASSIFICATION = 'restricted';$/m);
  assert.match(r.stdout, /^ALTER VIEW ANALYTICS\.STAGING\.stg_people MODIFY COLUMN email SET TAG GOVERNANCE\.TAGS\.CLASSIFICATION = 'personal';$/m);
  const untagged = mutatedManifest((m) => (m.nodes["model.privacy_fixture.stg_people"].columns.email.config.meta = {}));
  const bad = run(["classification", "emit", "snowflake", "--manifest", untagged, "--tiers", TIERS, "--tag", "GOVERNANCE.TAGS.CLASSIFICATION"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(run(["classification", "emit", "snowflake", "--manifest", MANIFEST, "--tiers", TIERS, "--tag", "x; drop table y"]).status, 2);
});

test("classification emit bigquery merges policy tags into the current schema, clears them for a tier with none, and needs the current schema", () => {
  const d = tmp();
  const current = [
    { name: "person_id", type: "STRING", mode: "REQUIRED", policyTags: { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/9999"] } },
    { name: "email", type: "STRING", mode: "NULLABLE", description: "kept" },
    { name: "tax_id", type: "STRING", mode: "NULLABLE" },
  ];
  fs.writeFileSync(path.join(d, "cur.json"), JSON.stringify(current));
  const r = run(["classification", "emit", "bigquery", "--manifest", MANIFEST, "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(r.status, 0, all(r));
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out[0], { name: "person_id", type: "STRING", mode: "REQUIRED", policyTags: { names: [] } });
  assert.deepEqual(out[1], { name: "email", type: "STRING", mode: "NULLABLE", description: "kept", policyTags: { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/2222"] } });
  assert.deepEqual(out[2].policyTags, { names: ["projects/example-project/locations/us/taxonomies/1111/policyTags/3333"] });
  assert.equal(run(["classification", "emit", "bigquery", "--manifest", MANIFEST, "--tiers", TIERS, "--model", "dim_people"]).status, 2);
  fs.writeFileSync(path.join(d, "extra.json"), JSON.stringify([...current, { name: "phone", type: "STRING" }]));
  const extra = run(["classification", "emit", "bigquery", "--manifest", MANIFEST, "--tiers", TIERS, "--model", "dim_people", "--current-schema", path.join(d, "extra.json")]);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /dim_people\.phone: no meta\.classification/);
  const t = JSON.parse(tiersText);
  delete t.tiers.personal.bigquery_policy_tag;
  fs.writeFileSync(path.join(d, "t.json"), JSON.stringify(t));
  const noTag = run(["classification", "emit", "bigquery", "--manifest", MANIFEST, "--tiers", path.join(d, "t.json"), "--model", "dim_people", "--current-schema", path.join(d, "cur.json")]);
  assert.equal(noTag.status, 1);
  assert.match(noTag.stderr, /tier personal: no bigquery_policy_tag/);
});

// ---------------------------------------------------------------------------------------------------
// deletion-map

const dm = (map, extra = []) => run(["deletion-map", "--map", map, "--prisma", `${FIX}/schema.prisma`, "--tiers", TIERS, ...extra]);
function mapWith(fn) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, FIX, "deletion-map.json"), "utf8"));
  fn(m);
  const f = path.join(tmp(), "map.json");
  fs.writeFileSync(f, JSON.stringify(m));
  return f;
}

test("deletion-map passes a map that holds every personal store, and says what it could not check", () => {
  const r = dm(`${FIX}/deletion-map.json`);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /NOT CHECKED: stores\[2\] \(warehouse copy\) holds dbt:dim_people, and no --manifest was given/);
  const both = dm(`${FIX}/deletion-map.json`, ["--manifest", MANIFEST]);
  assert.equal(both.status, 1, "with the manifest, stg_people holds personal data and is on no store");
  assert.match(both.stderr, /dbt:stg_people holds personal data/);
});

test("deletion-map fails when the embeddings are missing from the map", () => {
  const r = dm(`${FIX}/deletion-map-no-embeddings.json`);
  assert.equal(r.status, 1, all(r));
  assert.match(r.stderr, /prisma:NoteEmbedding holds personal data .* and no store on the map holds it/);
  assert.match(r.stderr, /prisma:NoteEmbedding has a vector column and is not on the map as an embedding store/);
  // on the map, but as the wrong kind of store
  const wrongKind = mapWith((m) => (m.stores[1].kind = "primary"));
  const w = dm(wrongKind);
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
    const r = dm(mapWith(fn));
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
    [(j) => (j.rules[0].enforcement.kind = "lifecycle-rule"), /has no lifecycle-rule in it/],
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

test("retention with no tiers file says the tier comparison is NOT CHECKED", () => {
  const d = tmp();
  fs.cpSync(path.join(ROOT, FIX), path.join(d, FIX), { recursive: true });
  const r = run(["retention", "--rules", `${FIX}/retention.json`], d);
  assert.equal(r.status, 0, all(r));
  assert.match(r.stdout, /NOT CHECKED: no governance\/tiers\.json/);
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
