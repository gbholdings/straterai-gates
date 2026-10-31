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
| `governance.yml` | Runs `scripts/governance-check.mjs` checks (for example `credentials`, below) and records each result as an evidence entry. The `governance` job reads the tree with `contents: read` and no token; a separate `publish` job, which never runs on a pull request, holds `contents: write` and writes only the evidence branch. An empty `checks` fails: nothing ran is not a pass. | `checks` (one `<plugin>:<skill>/<gate>=<arguments>` per line), `evidence_branch` (`governance-evidence`), `evidence_artifact` (`governance-evidence`), `gates_sha` |

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
- A reusable workflow cannot exceed the caller's permissions. `dbt.yml` and `bq-dry-run.yml` need `id-token: write` in the stub, `datacontract.yml` needs `pull-requests: write` (from v1.2.0, for the consumer notice; only its `notice` job, which never checks out the PR, holds it), and `governance.yml` needs `contents: write` (from v1.3.0 only its `publish` job holds it, on push to the default branch, schedule and manual runs, for the evidence branch). A caller still on `contents: read` that bumps `datacontract.yml` to v1.2.0 fails to start until it adds `pull-requests: write`.
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

`node scripts/governance-check.mjs evidence merge --from <one run's entries.json> [--file governance/evidence.json]` appends another file's entries; an entry without the shape below exits 4 and nothing is written.

`governance/evidence.json` is a JSON array of `{ "check", "date" (ISO 8601 UTC), "result", "run_link" (URL or null), "commit", "detail" }`. It only grows: the script reads, appends, verifies no earlier entry changed, and writes through a temp file. A file it cannot parse exits 4 and is left untouched. Exit 2 is a usage error. On push to the default branch, schedule and manual runs, `governance.yml`'s `publish` job merges the run's entries and commits the file to the `governance-evidence` branch, touching nothing else; on a pull request it uploads the would-be file as an artifact and writes no branch. The file records what ran and what it found. It does not say a repo is compliant.

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
node scripts/governance-check.mjs credentials --config <file or glob> [--config ...] [--targets .claude/db-targets.json]
```

Fails (exit 1) when a committed file carries a database connection string with a literal password for a non-local host. It reads URL connection strings (`postgres://`, `postgresql+driver://`, `mysql://`, `mongodb+srv://`, `redis://`, `sqlserver://`, `jdbc:...`) with the password in the userinfo or a `password=`/`pwd=` parameter, and key=value strings (libpq `host=... password=...`, ADO.NET `Server=...;Password=...`). The password is never printed.

- **Local** is `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `host.docker.internal`, a socket path, or a one-label name (`db`, `postgres`: a compose or CI service). With `--targets`, a variable that is the `read_env` or `write_env` of a target whose `env` is not `local`, `dev` or `ci` is non-local whatever its host, so a tunnel to staging on `localhost:6543` fails; an unknown `env` counts as `prod`.
- **A reference is not a committed password.** `${NAME}`, `$NAME`, `${{ secrets.NAME }}`, `{{ ... }}` and `%NAME%` pass with a note. A placeholder such as `<password>` or `changeme` fails: it tells the next person to paste one in.
- **Not read:** a separate `DB_PASSWORD=` variable, which is not a connection string. A reviewer still has to look for one.
- **NOT CHECKED is exit 2, never a pass:** no `--config`, a missing path, a directory, a glob (expanded over committed files with `git ls-files`) that matches nothing, or an unreadable `--targets`.

## What is in this repo

- `.github/workflows/`: the gates above, and `self-test`, `fact-scan`, `zizmor` and `release`.
- `scripts/`: `governance-check.mjs` and `bq-dry-run-check.mjs` (Node 20+, no dependencies), `next-tag.mjs`, `publish-evidence.sh`.
- `test/`: `governance-check.test.mjs` and `bq-dry-run-check.test.mjs` (`node --test test/*.test.mjs`) and `run-blocks.mjs`, which runs each gate's `run:` blocks against `test/fixtures/` in a temp git repo, evaluating each step's `if:` and putting a recording stand-in for `gh` on the PATH (needs `bash`, `git`, `node`, and Python with PyYAML; `datacontract-cli` for the contract cases). A failing fixture carries `expect-log`, so it must fail for its stated reason.

## Rules for changes here

- Every action is pinned to a 40-character SHA with a version comment.
- `permissions:` is set per job, least privilege.
- No `${{ inputs.* }}` or `${{ github.event.* }}` inside a `run:` block. Values go through `env:`. `zizmor` checks it.
- No client names, internal hosts or thresholds. `fact-scan` reads a deny list from a private repo with a read-only GitHub App token and prints only `file:line deny-rule #n`. It fails closed: no app secrets (a fork PR, say) means a red check and no scan.
- Every PR carries one label: `semver:major` (an input removed or renamed), `semver:minor` (a new input or gate) or `semver:patch`. On merge, `release.yml` tags the merge commit.

## What the self-test cannot prove

`bq-dry-run.yml` needs a Google Cloud project and keyless auth, which this public repo's CI does not have. The self-test runs its change detection and CI-profile check against fixtures and the script against a stubbed API; the live dry run is `test/bq-dry-run-check.test.mjs`'s last test, which runs when `BQ_ACCESS_TOKEN` and `BQ_LIVE_PROJECT` are set and is skipped otherwise.
