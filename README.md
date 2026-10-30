# straterai-gates

Reusable GitHub Actions workflows that wrap open-source database tools, plus the small scripts they run. Apache-2.0.

A repo calls a gate with a few lines and gets the same check every other repo gets. Releases are tags (`v1.0.0`); a tag never moves, so pin the full commit SHA and let Dependabot bump it.

## Gates

| Workflow | What it checks | Inputs (defaults) |
|---|---|---|
| `squawk.yml` | [squawk](https://squawkhq.com/) lint over the migration files a PR adds or changes. | `migration_globs` (Prisma and common raw-SQL folders), `squawk_version` (`2.70.0`), `config_path` (`.squawk.toml`), `lint_all` (`false`) |
| `dbt.yml` | sqlfluff, then `dbt build --target ci` against a CI-only database. | `dbt_project_dir` (`.`), `adapter_package` (`dbt-bigquery==1.12.1`), `dbt_core` (`1.12.6`), `sqlfluff` (`4.4.0`), `auth` (`wif-google` or `none`), `workload_identity_provider`, `service_account`, `lint_all` |
| `datacontract.yml` | [datacontract-cli](https://cli.datacontract.com/) lint of every contract, `breaking` against the base branch, and a block on deleting, renaming or retiring a contract that `RETIRED.md` on the base branch does not list. | `contracts_glob` (`contracts/*.odcs.yaml`), `datacontract_cli` (`1.2.8`), `lint_all` |
| `governance.yml` | Runs `scripts/governance-check.mjs` checks and records each result as an evidence entry. | `checks` (one `<plugin>:<skill>/<gate>=<arguments>` per line), `evidence_branch` (`governance-evidence`), `gates_sha` |

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
- A reusable workflow cannot exceed the caller's permissions. `dbt.yml` needs `id-token: write` in the stub, and `governance.yml` needs `contents: write` (used only on push and schedule, only for the evidence branch).
- No workflow has a `paths:` filter, for the same "Expected" reason. Each job always runs and passes when there is nothing to check.

## Evidence

`node scripts/governance-check.mjs evidence append --check <plugin>:<skill>/<gate> --result pass|fail|not_run [--run-link <url>] [--commit <sha>] [--detail <text>] [--file governance/evidence.json]`

`governance/evidence.json` is a JSON array of `{ "check", "date" (ISO 8601 UTC), "result", "run_link" (URL or null), "commit", "detail" }`. It only grows: the script reads, appends, verifies no earlier entry changed, and writes through a temp file. A file it cannot parse exits 4 and is left untouched. Exit 2 is a usage error. On push and schedule `governance.yml` commits the file to the `governance-evidence` branch, touching nothing else; on a pull request it uploads the would-be file as an artifact and writes no branch. The file records what ran and what it found. It does not say a repo is compliant.

## What is in this repo

- `.github/workflows/`: the gates above, and `self-test`, `fact-scan`, `zizmor` and `release`.
- `scripts/`: `governance-check.mjs` (Node 20+, no dependencies), `next-tag.mjs`, `publish-evidence.sh`.
- `test/`: `governance-check.test.mjs` (`node --test test/*.test.mjs`) and `run-blocks.mjs`, which runs each gate's `run:` blocks against `test/fixtures/` in a temp git repo (needs `bash`, `git`, `node`, and Python with PyYAML; `datacontract-cli` for the contract cases).

## Rules for changes here

- Every action is pinned to a 40-character SHA with a version comment.
- `permissions:` is set per job, least privilege.
- No `${{ inputs.* }}` or `${{ github.event.* }}` inside a `run:` block. Values go through `env:`. `zizmor` checks it.
- No client names, internal hosts or thresholds. `fact-scan` reads a deny list from a private repo with a read-only GitHub App token and prints only `file:line deny-rule #n`. It fails closed: no app secrets (a fork PR, say) means a red check and no scan.
- Every PR carries one label: `semver:major` (an input removed or renamed), `semver:minor` (a new input or gate) or `semver:patch`. On merge, `release.yml` tags the merge commit.
