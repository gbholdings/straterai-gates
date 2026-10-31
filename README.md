# straterai-gates

Reusable GitHub Actions workflows that wrap open-source database tools, plus the small scripts they run. Apache-2.0.

A repo calls a gate with a few lines and gets the same check every other repo gets. Releases are tags (`v1.0.0`); a tag never moves, so pin the full commit SHA and let Dependabot bump it.

## Gates

| Workflow | What it checks | Inputs (defaults) |
|---|---|---|
| `squawk.yml` | [squawk](https://squawkhq.com/) lint over the migration files a PR adds or changes. | `migration_globs` (Prisma and common raw-SQL folders), `squawk_version` (`2.70.0`), `config_path` (`.squawk.toml`), `lint_all` (`false`) |
| `dbt.yml` | sqlfluff, then `dbt build --target ci` against a CI-only database. | `dbt_project_dir` (`.`), `adapter_package` (`dbt-bigquery==1.12.1`), `dbt_core` (`1.12.6`), `sqlfluff` (`4.4.0`), `auth` (`wif-google` or `none`), `workload_identity_provider`, `service_account`, `lint_all` |
| `datacontract.yml` | [datacontract-cli](https://cli.datacontract.com/) lint of every contract; each contract's columns and types against the real schema (`governance-check contract-schema`); an owner on every contract, and on every dbt model with a manifest (`governance-check owner`); `breaking` against the base branch, and a block on deleting, renaming or retiring a contract that `RETIRED.md` on the base branch does not list. When one of those breaks on a PR, one comment names each consumer the base copy of the contract lists. | `contracts_dir` (`contracts`), `contracts_glob` (`contracts/**/*.odcs.yaml`), `datacontract_cli` (`1.2.8`, installed from a hash-pinned lockfile), `lint_all`, `prisma_schema`, `dbt_manifest`, `dbt_catalog`, `dbt_artifact`, `open_consumer_issues` (`false`, needs the secret `CONSUMER_ISSUES_TOKEN`), `evidence_artifact` (`datacontract-evidence`), `gates_sha` (a 40-character commit), `fixture` (self-test only) |
| `bq-dry-run.yml` | Compiles the dbt models a PR can change and dry-runs each on BigQuery (free; nothing runs). Fails when a model would process more bytes than its budget in `warehouse-budgets.yml` (`default` plus per-model bytes, e.g. `10 GiB`), or when the gate cannot measure it. See [bq-dry-run](#bq-dry-run). | `project_id` (required), `location` (`US`), `dbt_project_dir` (`.`), `budgets_path` (`warehouse-budgets.yml`), `adapter_package`, `dbt_core`, `workload_identity_provider`, `service_account`, `gates_sha`, `lint_all` |
| `governance.yml` | Runs `scripts/governance-check.mjs` checks (evidence, contract checks, monitor routing; classification, deletion map, retention and exports; database credentials) and records each result as an evidence entry. A `checks` with no line to run fails as NOT CHECKED: nothing ran is not a pass. | `checks` (one `<plugin>:<skill>/<gate>=<arguments>` per line), `evidence_branch` (`governance-evidence`), `evidence_artifact` (`governance-evidence`), `gates_sha`, `dbt_parse`, `gx` |

`lint_all` lints every tracked file that matches instead of the PR's diff. The self-test uses it, and so can a repo adopting a gate for the first time.

The squawk gate in this release is the lint step only. The destructive-change approval guard (a drop, truncate, rename or retype needs a reviewer's approval) arrives as a minor release.

### Caller stub

```yaml
name: squawk
on: pull_request
permissions:
  contents: read
jobs:
  squawk:
    uses: gbholdings/straterai-gates/.github/workflows/squawk.yml@<40-char sha> # v1.0.0
    with:
      migration_globs: ":(glob)prisma/migrations/**/migration.sql :(glob)migrations/**/*.sql"
```

Each workflow's header comment has its own stub.

- The required-check name is `<caller job> / <called job>`: `squawk / squawk`, not `squawk`. A repo that switches from a copied workflow to the stub updates its branch protection in the same change, or every PR waits on "Expected".
- A reusable workflow cannot exceed the caller's permissions. `dbt.yml` and `bq-dry-run.yml` need `id-token: write` in the stub, `datacontract.yml` needs `pull-requests: write` (from v1.2.0, for the consumer notice; only its `notice` job, which never checks out the PR, holds it), and `governance.yml` needs `contents: write` (held only by its `publish` job, which runs on push and schedule and never checks out a pull request, and only for the evidence branch). A caller still on `contents: read` that bumps `datacontract.yml` to v1.2.0 fails to start until it adds `pull-requests: write`.
- No workflow has a `paths:` filter, for the same "Expected" reason. Each job always runs and passes when there is nothing to check.

## bq-dry-run

Which models: an added or edited `.sql` under `<dbt project>/models/` checks that model and everything downstream of it (`<model>+`), because a model turned into a view moves its scan into every model that selects from it. Any other change under the dbt project (a macro, a source or schema YAML, `dbt_project.yml`, packages, seeds, snapshots, a deleted or renamed model) or to the budget file checks every model, as does any change in a project whose `dbt_project.yml` sets `model-paths`. Markdown and `.github/` changes are ignored.

What the budget covers: the bytes BigQuery estimates for each model's compiled `SELECT`. A model the gate cannot measure fails as NOT MEASURED rather than passing at a low number:

- an estimate BigQuery marks `LOWER_BOUND`, which is what an external or federated table returns (0 bytes, whatever it would bill);
- SQL BigQuery reads as a script (`EXECUTE IMMEDIATE`, several statements), whose dry run reports 0 bytes for the work it would do;
- a model with `pre_hook` or `post_hook` SQL or a `sql_header`, none of which is in the compiled file;
- an incremental model, whose `MERGE` also scans the target table.

The last two can be accepted per model under `accept_unmeasured:` in the budget file, with a reason; the gate then measures only the `SELECT` and prints the reason. Seeds, snapshots and tests are not measured. A model that selects from a relation that does not exist yet in the `ci` target (a new upstream model in the same PR, say) fails on the dry run's 404.

Spending: `dbt compile` runs SQL the PR wrote (introspection, and any `run_query()` or `statement` block in a macro or model) as real queries under the CI credential. The `ci` target must set `maximum_bytes_billed` to a literal byte count, which dbt-bigquery puts on every query it sends, and the gate refuses to compile without it. A `run_query()` over a 38 GB table under a 10 MB cap fails the compile with "Query exceeded limit for bytes billed".

Access: the service account needs `roles/bigquery.jobUser` in the job project and `roles/bigquery.dataViewer` on the datasets the models read. A dry run checks `bigquery.tables.getData`, and with `roles/bigquery.metadataViewer` alone it is refused with a 403. Grant it no write role.

## Evidence

`node scripts/governance-check.mjs evidence append --check <plugin>:<skill>/<gate> --result pass|fail|not_run [--run-link <url>] [--commit <sha>] [--detail <text>] [--file governance/evidence.json]`

`governance/evidence.json` is a JSON array of `{ "check", "date" (ISO 8601 UTC), "result", "run_link" (URL or null), "commit", "detail" }`. It only grows: the script reads, appends, verifies no earlier entry changed, and writes through a temp file. A file it cannot parse exits 4 and is left untouched. Exit 2 is a usage error. A check line in `governance.yml` that exits 2 (NOT CHECKED) is recorded as `not_run`, exit 0 as `pass` and anything else as `fail`; only `pass` lets the job succeed. On push and schedule `governance.yml` commits the file to the `governance-evidence` branch, touching nothing else; on a pull request it uploads the run's entries as an artifact and writes no branch. The job that runs the checks holds `contents: read` only; a second job, `publish`, which runs on push and schedule and never checks out a pull request, holds `contents: write` and appends the entries (`evidence append --from`). The file records what ran and what it found. It does not say a repo is compliant.

## Contract checks

```
node scripts/governance-check.mjs owner (--contracts <dir> | --contract <file> ...) [--manifest target/manifest.json]
node scripts/governance-check.mjs contract-schema --contract <file> (--prisma prisma/schema.prisma|prisma/schema | --manifest target/manifest.json [--catalog target/catalog.json])
node scripts/governance-check.mjs consumers --contract <file> [--format lines|markdown] [--label <path>]
```

- **Owner** is an ODCS `team` member with `role: owner` and a `username`: `team: [{ username, role: owner }]` in ODCS v3.0.x, `team: { name, members: [...] }` from v3.1.0. A member whose `dateOut` has passed does not count. `datacontract lint` 1.2.8 rejects a top-level `owner:` key. With `--manifest`, every model of the project (not of installed packages) needs `meta.owner` or `config.meta.owner`.
- **Consumers** are a top-level `customProperties` entry: `{ property: consumers, value: [{ repo: <owner/name>, team: <name or org/team> }] }`. `datacontract lint` 1.2.8 rejects a top-level `consumers:` key. A team written `org/team` is @-mentioned in the notice.
- **contract-schema** fails when a contract column is missing from the table or model, when its `logicalType` cannot hold the schema's type, when its `physicalType` differs (Postgres for Prisma, including Prisma's defaults such as `DateTime` = `timestamp(3)`; the warehouse type for dbt), or when the contract says `required` and the schema allows null. A schema column the contract leaves out is a note, not a failure: a contract may publish a subset. For dbt, pass `--catalog` for the warehouse's real types; without it the YAML's `data_type` is used, and a typed contract column with no declared type fails as unverifiable.
- **Which table.** A contract object names its table with `physicalName` (or `name`), optionally schema-qualified (`billing.orders`). Prisma matches the table (`@@map`, else the model name when unmapped) and its `@@schema`: the qualifier, or else the contract's server `schema` when its servers give exactly one, must equal the model's schema (`public` on Postgres without `@@schema`). A Prisma model name that is not the table does not match. dbt matches the relation (`alias`, which dbt sets to `<name>_v<n>` for a version), never the bare model name; a qualified name is also compared with the node's `schema`, an unqualified one is not, because CI often builds into another schema.
- **Prisma.** `--prisma` takes a file or a multi-file schema folder (every `*.prisma` under it). The datasource must be among the files read: without its provider the check exits 2. Physical types are known for Postgres only; on another provider the output starts `WARNING: ... physical types are NOT CHECKED`. A scalar list (`String[]`) is a Postgres array that takes NULL, so `required: true` on it fails, and a contract may describe it the way `datacontract import sql` does (`logicalType: string`, `physicalType: TEXT[]`).
- **dbt nullability is not checked.** A manifest does not say a column takes NULL, so `required` is not compared against dbt; put a `not_null` test on the model instead.
- **No schema source** in `datacontract.yml`: drift is NOT CHECKED. The job warns, says so in the step summary, and records `contract-schema` as `not_run`.
- YAML contracts are read with Python's PyYAML (installed with datacontract-cli), run isolated (`python3 -I`, from the temp directory), so a `yaml.py` in the repository is never imported. No PyYAML exits 2; `GOVERNANCE_PYTHON` picks the interpreter.
- The notice renders every path, owner and team as a code span with line breaks, control characters and backticks removed, so none of them can add Markdown, HTML, a mention or a link. A path under the contracts folder with a control character in it fails the gate's first step.

## Credentials check

```
node scripts/governance-check.mjs credentials (--config <file or glob> [--config ...] | --all-tracked) [--targets .claude/db-targets.json] [--local-host <name> ...]
```

Fails (exit 1) when a committed file carries a database connection string with a literal password for a non-local host. It reads URL connection strings (`postgres://`, `postgresql+driver://`, `mysql://`, `mongodb+srv://`, `redis://`, `sqlserver://`, `jdbc:...`) with the password in the userinfo (also when it holds an unencoded `/`, `#` or `?`) or a `password=`/`pwd=` parameter and the host in the authority or a `host=` parameter, and key=value strings (libpq `host=... password=...`, ADO.NET `Server=...;Password=...`), in UTF-8 or UTF-16 (with a BOM). `--all-tracked` reads every committed file (`git ls-files`), skipping binaries and files over 2 MB, so Terraform, compose files, CI workflows and notebooks are read without naming each one.

- **Local** is `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `host.docker.internal`, a socket path other than Cloud SQL's, and a one-label name only when it is a common service name (`db`, `postgres`, `mysql`, `redis`, ...) or named with `--local-host`. A Cloud SQL socket (`/cloudsql/...`, also as `%2Fcloudsql%2F...` or `?host=/cloudsql/...`) is production, and any other one-label name (`proddb`) is non-local. With `--targets`, a variable that is the `read_env` or `write_env` of a target whose `env` is not `local`, `dev` or `ci` is non-local whatever its host, so a tunnel to staging on `localhost:6543` fails; an unknown `env` counts as `prod`. The variable is found on `NAME=`, `NAME:`, `{"name": "NAME", "value": ...}` and a `- name: NAME` line followed by `value:` (Cloud Run and Kubernetes env lists).
- **A reference is not a committed password.** `${NAME}`, `$NAME`, `${{ secrets.NAME }}`, `{{ ... }}`, `%NAME%` and a Python `{name}` pass with a note. A placeholder such as `<password>` or `changeme` fails: it tells the next person to paste one in.
- **The password is never printed**, on any stream: every path, pattern, flag, name and host in the output has its userinfo and any `password=` value masked, also when a connection string is passed where a path belongs, and a `--targets` file that is not JSON is reported without quoting it.
- **Not read:** a separate `DB_PASSWORD=` variable, which is not a connection string, and a password on the line after a JDBC URL (`spring.datasource.password=`). A reviewer still has to look for those. Cloud credentials (access keys, service-account keys) are the security pack's scanner's.
- **NOT CHECKED is exit 2, never a pass:** no `--config` or `--all-tracked`, a missing path, a directory, a binary named with `--config`, a glob (expanded over committed files with `git ls-files`) that matches nothing, or an unreadable `--targets`. `governance.yml` records it as `not_run`.

## Classification, deletion map, retention and exports

```
node scripts/governance-check.mjs classification prisma [--schema prisma/schema.prisma] [--base origin/main] [--tiers governance/tiers.json] [--emit-comments prisma/migrations]
node scripts/governance-check.mjs classification dbt --manifest target/manifest.json [--repo <dbt project>] [--catalog target/catalog.json] [--path models/marts/ ...]
node scripts/governance-check.mjs classification emit bigquery --manifest target/manifest.json --model <name> --current-schema <file>
node scripts/governance-check.mjs classification emit snowflake --manifest target/manifest.json --tag <database.schema.tag> [--model <name> ...]
node scripts/governance-check.mjs deletion-map [--map governance/deletion-map.json] (--prisma <schema> | --manifest <manifest> [--repo <dbt project>])
node scripts/governance-check.mjs retention [--rules governance/retention.json]
node scripts/governance-check.mjs exports --module <path or glob> ... (--prisma <schema> | --manifest <manifest> [--repo <dbt project>]) [--mask <function> ...] [--strict true]
```

- **Tiers** are the repository's own, in `governance/tiers.json`; this repo defines none. `{ "tiers": { "<name>": { "personal_data": true|false, "model": "allow|mask|deny", "embedding": "...", "log": "...", "export": "...", "retention_days": <optional>, "bigquery_policy_tag": "<policy tag resource name>" | null } } }`. A missing file, an unknown key or a missing rule exits 2: no default tier applies. `test/fixtures/governance/privacy/tiers.json` is an example.
- **classification prisma** reads `/// @classification(<tier>)` above a field or trailing it on the same line (a blank line or a `//` line between a tag and its field detaches it), and fields with `@ignore` and models with `@@ignore` too (their columns still hold data). `--schema` takes a file or a folder; a file whose folder holds other `*.prisma` files is one file of a multi-file schema, so every `*.prisma` in that folder without a datasource of its own is read with it (at `--base` too). It fails on a field with no tag that `--base` does not have, on an untagged field whose column, type, list-ness or `@db` type differs from the base (a changed column is a new one), on any unknown tier, on a malformed tag, and on two different tags; an unchanged untagged field the base already has is a warning. Without `--base` every field is new. A base that does not resolve exits 2, so a shallow checkout fails instead of passing; `governance.yml` checks out with `fetch-depth: 0`. A schema the base does not have makes every field new.
- **--emit-comments** runs only when the check passes and the datasource is Postgres. It replays the migrations (in folder order) to learn the comment each column holds once they have all run: a `COMMENT ON COLUMN` sets it, and a later `DROP TABLE`, `CREATE TABLE`, `RENAME TO`, or `ALTER TABLE` that names the column (a drop, a re-add, a type change Prisma writes as both) forgets it, because Postgres drops a comment with its column. It writes `<migrations>/<UTC timestamp>_classification_comments/migration.sql` with one `COMMENT ON COLUMN "<table>"."<column>" IS 'classification:<tier>'` per tagged column whose comment is not known to be set (`@@map`, `@map` and `@@schema` names; `IS NULL` for a column whose tag was removed). Forgetting too much only sets a comment again. Nothing changed, nothing written. Postgres comments, not `SECURITY LABEL`, which needs a label provider loaded. Self-test applies the output on Postgres 17, then drops and re-adds a tagged column and applies the next output (`test/emit-comments-pg.sh`).
- **classification dbt** needs `meta.classification` (or `config.meta.classification`) with a known tier on every declared column of every model, snapshot and seed of the project, or under `--path`. The manifest must be a current parse of a dbt project of its name under `--repo` (default `.`), by the test `monitors` applies; an old, unversioned or unmatched manifest exits 2. `classification emit`, `deletion-map --manifest` and `exports --manifest` apply the same test. A `--path` that matches no model exits 2. With `--catalog`, a warehouse column the YAML does not declare fails (except the `dbt_scd_id`, `dbt_updated_at`, `dbt_valid_from`, `dbt_valid_to` and `dbt_is_deleted` columns dbt adds to a snapshot); without it, those are NOT CHECKED, so the check exits 2.
- **classification emit** generates, and never applies. `bigquery` merges each column's tier's `bigquery_policy_tag` into the current schema (`bq show --schema --format=prettyjson <project>:<dataset>.<table>`), because `bq update <table> <schema.json>` replaces the whole schema; a tier whose tag is `null` clears the column's tags (`names: []`), and a tier with no `bigquery_policy_tag` key fails. A `RECORD` carries no tag; each leaf under it is tagged from its dbt column `parent.leaf`, or from its declared parent. `snowflake` prints `CREATE TAG IF NOT EXISTS ... ALLOWED_VALUES`, one `ALTER TAG ... ADD ALLOWED_VALUES` per tier (so a tier added after the tag exists is allowed), and one `ALTER TABLE|VIEW ... MODIFY COLUMN ... SET TAG <tag> = '<tier>'` per column. Every Snowflake identifier is quoted: an unquoted dbt name upper-cased, as Snowflake resolves it (so a reserved word such as `order` works), and a `quote: true` column or quoted relation in its exact case. Applying either is a write: run it with a credential that can, after review.
- **deletion-map** fails when a model or table with a `personal_data` column (from the tags) is held by no store on the map, when a model with an embedding column is not on it as an `embedding` store, when personal data is held and no `backup` store states `retention_days` and `after_restore: "reapply" | "expire"`, when an entry has no `delete` (the job, test or runbook that deletes a person there), and when it holds a model the schema does not have. An embedding column is a `vector`, `halfvec` or `sparsevec` (`Unsupported(...)` in Prisma, the `data_type` in dbt), or a `Float[]`, `Decimal[]` or `Bytes` column (a float array or bytes `data_type` in dbt) whose name says embed, vector or vec; it is personal data whatever its tag, because it is derived from its source row. `holds` takes `prisma:<Model>`, `dbt:<model>` (snapshots and seeds too) or `all`. An entry whose source was not given, or an untagged column, is NOT CHECKED: the check exits 2.
- **retention** fails a rule whose `enforcement` names a `file` that does not exist, does not mention its `id`, or holds no real enforcement of that `id`. A `scheduled-job` is a `google_cloud_scheduler_job` (Terraform) named `id` with a `schedule`, not `paused = true`, whose target reads as a deletion (delete, purge, prune, expire and the like); a Kubernetes `CronJob` named `id` with a `schedule`, not `suspend: true`, whose command deletes; a job `id` of a scheduled GitHub Actions workflow whose steps delete; or a crontab line naming `id`. A mention in prose, a TODO or a commented-out block is not a job. A `partition-expiration` is a `google_bigquery_table` with `time_partitioning.expiration_ms` above 0, a `google_bigquery_dataset` with `default_partition_expiration_ms` above 0, or DDL with `partition_expiration_days` above 0. A `lifecycle-rule` is a `google_storage_bucket` with a `lifecycle_rule` whose action is `Delete` with an age. A scheduled job also needs its `test`: a test file by its name (`*.test.ts`, `*.spec.js`, `test_*.py`, `*_test.go`, `tests/*.sql`), holding a test or an assertion, that names the job `id` or the rule's `table`. Without `governance/tiers.json` the tier comparison is NOT CHECKED (exit 2); with it, every tier with `retention_days` needs a rule that keeps it no longer. It reads the repository only: whether the deployed job is enabled and when it last ran (`gcloud scheduler jobs describe`) is NOT CHECKED here and left to the caller.
- **exports** is advisory. It warns on a line of an export module that writes a column whose tier's `export` is `mask` outside a call to the mask function (`--mask`, default `mask`), or names a column whose tier's `export` is `deny` (a column name of any length, `ip` included); an object key or a type annotation does not count. It also warns on a whole-row export, which writes every column without naming one: a Prisma `findMany` / `findFirst` / `findUnique` with no `select` on a model with a guarded column, `Object.values` or `Object.entries` of a row, `JSON.stringify` of a row, an object spread of a row, and `SELECT *`. `// governance: export-ok <reason>` trailing a line waives that line; on a line of its own it waives the next line; a waiver with no reason fails. `--strict true` fails on any warning. A `--module` glob that matches nothing exits 2. It reads text, not types: a row passed through a helper in another module is not seen.
- `evidence append --from <entries.json>` appends the entries of another evidence file, each validated; `governance.yml`'s `publish` job uses it.

## Monitor routing

```
node scripts/governance-check.mjs monitors [--repo .] (--manifest <dbt project>/target/manifest.json ... | --gx <gx dir> ... [--gx-python <python>])
```

Every run-time monitor must reach a person: it needs a deliverable alert destination and a real owner. In CI, have `governance.yml` parse the project itself and point the check at what it wrote:

```yaml
    with:
      dbt_parse: transform
      checks: |
        <plugin>:<skill>/monitors=monitors --repo . --manifest transform/target/manifest.json
```

For GX, set `gx: true` and pass `--gx <dir>`; the job installs GX Core from `requirements/` and sets `GATES_GX_PYTHON`.

- **Elementary** (`--manifest`, repeatable): every test in the `elementary` namespace (`volume_anomalies`, `freshness_anomalies`, `schema_changes` and the rest) needs `channel` and `owner`, read as Elementary reads them: the test's meta over its model's, at the top of `meta` or under `alerts_config`, from `meta` or `config.meta`. A value the test sets wins, so an empty `channel` on the test is not rescued by the model's. An `alert_suppression_interval` above 168 hours, or one that is not a number, fails. A manifest with no Elementary test is NOT CHECKED.
- **The manifest must be this commit's.** Its `metadata.project_name` must name a dbt project under `--repo`; every `.sql` there must be in it with the checksum dbt gives it (sha256 of the stripped text); every file it lists must exist; and no project file may be newer than its `generated_at`. Otherwise it is NOT CHECKED: a committed manifest is stale by construction. Every dbt project whose packages pull in Elementary must be covered by a `--manifest`.
- **GX Core** (`--gx`, repeatable): every checkpoint under `checkpoints/` needs an action that notifies with what delivery needs: `slack` (a webhook, or a token and a channel), `microsoft` (`teams_webhook`), `email` (`smtp_address`, `smtp_port` and `receiver_emails`), `opsgenie` (`api_key`) or `api` (`url`), with `notify_on` of `all` or `failure`. Every suite it validates needs `meta.owner`. Each context is then loaded in GX itself (`--gx-python`, or `GATES_GX_PYTHON`, a Python with `great_expectations`, run `-I` from a temp directory with no token in its environment); one GX refuses to load fails, and one not loaded is NOT CHECKED. Every directory under `--repo` holding `great_expectations.yml` must be covered by a `--gx`.
- **Placeholders are not owners or channels.** Empty, a bare `#` or `@`, `<...>`, anything containing `example`, and `TODO`, `TBD`, `none`, `n/a`, `changeme`, `owner`, `team` and the like fail.
- **Never both.** `--repo` (default `.`) is scanned for Elementary (`elementary-data/elementary` in `packages.yml` or `dependencies.yml`, or `elementary-data` in a Python dependency file) and GX (`great_expectations.yml`, or `great_expectations` or `great-expectations` anywhere in a dependency line: the Airflow provider, a `requirements*.txt` or any `.txt` under a `requirements/` folder, `pyproject.toml`, and a `Dockerfile` or `*.dockerfile`). Both in one repository exit 1. `dbt_packages/`, `target/`, virtualenvs and comments are not read.
- **NOT CHECKED is exit 2, never a pass,** and `governance.yml` records it as `not_run` (from the check's own status, not its exit code) and fails the job. A problem found elsewhere in the same run still exits 1, with the unchecked inputs listed under it.
- **Nothing from the repository reaches the log as a command.** Control characters in a path or a name are printed as `\u000a`-style escapes, no output line may start with `::`, and `governance.yml` prints each check between `::stop-commands::` markers.
- `test/monitors-engine.sh` proves it in the self-test on what the tools write: `dbt parse` with the Elementary package (dbt-core 1.12.6, dbt-duckdb 1.11.1, elementary 0.26.1) and GX Core 1.24.1 contexts, each installed from a hash-pinned file under `requirements/`. Each case the review found (a stale and a foreign manifest, placeholders, an eleven-year suppression, an email action GX refuses, a second project and a second context, GX through the Airflow provider, `requirements/prod.txt` and a `Dockerfile`, and a directory name that would inject a workflow command) is a line there.

## What is in this repo

- `.github/workflows/`: the gates above, and `self-test`, `fact-scan`, `zizmor` and `release`.
- `scripts/`: `governance-check.mjs` and `bq-dry-run-check.mjs` (Node 20+, no dependencies), `next-tag.mjs`, `version-check.mjs` (the self-test fails a PR whose `VERSION` is not the tag its `semver:` label will cut), `run-governance-checks.sh` and `dbt-parse.sh` (`governance.yml`'s check and parse steps), `publish-evidence.sh`.
- `test/`: `governance-check.test.mjs`, `monitors-check.test.mjs`, `privacy-check.test.mjs`, `governance-run.test.mjs` and `bq-dry-run-check.test.mjs` (`node --test test/*.test.mjs`) and `run-blocks.mjs`, which runs each gate's `run:` blocks against `test/fixtures/` in a temp git repo, evaluating each step's `if:` and putting a recording stand-in for `gh` on the PATH (needs `bash`, `git`, `node`, and Python with PyYAML; `datacontract-cli` for the contract cases). A failing fixture carries `expect-log`, so it must fail for its stated reason.

## Rules for changes here

- Every action is pinned to a 40-character SHA with a version comment.
- `permissions:` is set per job, least privilege.
- No `${{ inputs.* }}` or `${{ github.event.* }}` inside a `run:` block. Values go through `env:`. `zizmor` checks it.
- No client names, internal hosts or thresholds. `fact-scan` reads a deny list from a private repo with a read-only GitHub App token and prints only `file:line deny-rule #n`. It fails closed: no app secrets (a fork PR, say) means a red check and no scan.
- Every PR carries one label: `semver:major` (an input removed or renamed), `semver:minor` (a new input or gate) or `semver:patch`. On merge, `release.yml` tags the merge commit.

## What the self-test cannot prove

`bq-dry-run.yml` needs a Google Cloud project and keyless auth, which this public repo's CI does not have. The self-test runs its change detection and CI-profile check against fixtures and the script against a stubbed API; the live dry run is `test/bq-dry-run-check.test.mjs`'s last test, which runs when `BQ_ACCESS_TOKEN` and `BQ_LIVE_PROJECT` are set and is skipped otherwise.
