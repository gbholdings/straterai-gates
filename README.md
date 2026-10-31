# straterai-gates

Reusable GitHub Actions workflows that wrap open-source database tools, plus the small scripts they run. Apache-2.0.

A repo calls a gate with a few lines and gets the same check every other repo gets. Releases are tags (`v1.0.0`); a tag never moves, so pin the full commit SHA and let Dependabot bump it.

## Gates

| Workflow | What it checks | Inputs (defaults) |
|---|---|---|
| `squawk.yml` | A destructive-change guard, then [squawk](https://squawkhq.com/) lint, over the migration files a PR adds or changes. See [squawk](#squawk). | `migration_globs` and `migration_dirs` (Prisma at any depth, Supabase, Flyway, `db/migrate`, drizzle, any `migrations/`, any case), `squawk_version` (`2.71.0`), `squawk_sha256` (that release's Linux binaries), `config_path` (`.squawk.toml`), `lint_all` (`false`) |
| `dbt.yml` | sqlfluff, then `dbt build --target ci` against a CI-only database. | `dbt_project_dir` (`.`), `adapter_package` (`dbt-bigquery==1.12.1`), `dbt_core` (`1.12.6`), `sqlfluff` (`4.4.0`), `auth` (`wif-google` or `none`), `workload_identity_provider`, `service_account`, `lint_all` |
| `datacontract.yml` | [datacontract-cli](https://cli.datacontract.com/) lint of every contract, `breaking` against the base branch, and a block on deleting, renaming or retiring a contract that `RETIRED.md` on the base branch does not list. | `contracts_glob` (`contracts/*.odcs.yaml`), `datacontract_cli` (`1.2.8`), `lint_all` |
| `bq-dry-run.yml` | Compiles the dbt models a PR can change and dry-runs each on BigQuery (free; nothing runs). Fails when a model would process more bytes than its budget in `warehouse-budgets.yml` (`default` plus per-model bytes, e.g. `10 GiB`), or when the gate cannot measure it. See [bq-dry-run](#bq-dry-run). | `project_id` (required), `location` (`US`), `dbt_project_dir` (`.`), `budgets_path` (`warehouse-budgets.yml`), `adapter_package`, `dbt_core`, `workload_identity_provider`, `service_account`, `gates_sha`, `lint_all` |
| `governance.yml` | Runs `scripts/governance-check.mjs` checks and records each result as an evidence entry. | `checks` (one `<plugin>:<skill>/<gate>=<arguments>` per line), `evidence_branch` (`governance-evidence`), `gates_sha` |

`lint_all` lints every tracked file that matches instead of the PR's diff. The self-test uses it, and so can a repo adopting a gate for the first time.

### Caller stub

```yaml
name: squawk
on:
  pull_request:
  pull_request_review:
    types: [submitted, dismissed]
permissions:
  contents: read
  pull-requests: read
concurrency:
  group: squawk-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  squawk:
    uses: gbholdings/straterai-gates/.github/workflows/squawk.yml@<40-char sha> # v1.2.0
```

Each workflow's header comment has its own stub.

- The required-check name is `<caller job> / <called job>`: `squawk / squawk`, not `squawk`. A repo that switches from a copied workflow to the stub updates its branch protection in the same change, or every PR waits on "Expected".
- A reusable workflow cannot exceed the caller's permissions. `dbt.yml` and `bq-dry-run.yml` need `id-token: write` in the stub, and `governance.yml` needs `contents: write` (used only on push and schedule, only for the evidence branch).
- No workflow has a `paths:` filter, for the same "Expected" reason. Each job always runs and passes when there is nothing to check.

## squawk

The guard parses each added or changed migration with Postgres's own parser (libpg_query, through `pglast`, pinned by wheel hash) and fails the job on a destructive change: any DROP, a dropped column, constraint or default, TRUNCATE, DELETE and UPDATE anywhere, a rename, a type or collation change, a required column with no default, SQL it cannot read, and the rest listed in the workflow's header. Comments, string literals, `squawk-ignore` and the repo's squawk config never change what it finds. One thing clears a finding: an approving review on the PR's current head commit from someone who can push to the repository and is not the PR's author, read with one GraphQL query (`authorCanPushToRepository`). The red check is the cue for that person.

- **The review trigger.** The stub runs on `pull_request_review` (submitted, dismissed), so an approval re-runs the check. The gate takes the base and head from the event's `pull_request` object, which both events carry (`github.base_ref` is empty on a review event), checks out the head commit itself, and refuses to run if the checkout is not that commit.
- **The concurrency group** lets only the latest run per pull request report. A review submitted and then dismissed starts two runs on the same commit.
- **`DROP INDEX` cues a human.** It holds no rows, but a query may depend on it, so it has its own rule (`guard-drop-index`): show the reviewer the index's `pg_stat_user_indexes.idx_scan` and the query sites. An index the same file builds again under the same name (a changed definition) does not count.
- **A collation change** (`ALTER COLUMN ... TYPE ... COLLATE`) has its own rule (`guard-collation`): its indexes must be rebuilt.
- **squawk is the release binary**, downloaded from GitHub and checked against `squawk_sha256`, so no package manager runs in the checkout. 2.71.0 is not on npm.

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

`governance/evidence.json` is a JSON array of `{ "check", "date" (ISO 8601 UTC), "result", "run_link" (URL or null), "commit", "detail" }`. It only grows: the script reads, appends, verifies no earlier entry changed, and writes through a temp file. A file it cannot parse exits 4 and is left untouched. Exit 2 is a usage error. On push and schedule `governance.yml` commits the file to the `governance-evidence` branch, touching nothing else; on a pull request it uploads the would-be file as an artifact and writes no branch. The file records what ran and what it found. It does not say a repo is compliant.

## What is in this repo

- `.github/workflows/`: the gates above, and `self-test`, `fact-scan`, `zizmor` and `release`.
- `scripts/`: `governance-check.mjs` and `bq-dry-run-check.mjs` (Node 20+, no dependencies), `next-tag.mjs`, `publish-evidence.sh`.
- `test/`: `bin/gh`, a stand-in `gh` that the squawk approval cases use; `governance-check.test.mjs` and `bq-dry-run-check.test.mjs` (`node --test test/*.test.mjs`) and `run-blocks.mjs`, which runs each gate's `run:` blocks against `test/fixtures/` in a temp git repo (needs `bash`, `git`, `node`, and Python with PyYAML; `datacontract-cli` for the contract cases).

## Rules for changes here

- Every action is pinned to a 40-character SHA with a version comment.
- `permissions:` is set per job, least privilege.
- No `${{ inputs.* }}` or `${{ github.event.* }}` inside a `run:` block. Values go through `env:`. `zizmor` checks it.
- No client names, internal hosts or thresholds. `fact-scan` reads a deny list from a private repo with a read-only GitHub App token and prints only `file:line deny-rule #n`. It fails closed: no app secrets (a fork PR, say) means a red check and no scan.
- Every PR carries one label: `semver:major` (an input removed or renamed), `semver:minor` (a new input or gate) or `semver:patch`. On merge, `release.yml` tags the merge commit.

## What the self-test cannot prove

`bq-dry-run.yml` needs a Google Cloud project and keyless auth, which this public repo's CI does not have. The self-test runs its change detection and CI-profile check against fixtures and the script against a stubbed API; the live dry run is `test/bq-dry-run-check.test.mjs`'s last test, which runs when `BQ_ACCESS_TOKEN` and `BQ_LIVE_PROJECT` are set and is skipped otherwise.
