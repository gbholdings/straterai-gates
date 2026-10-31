#!/usr/bin/env bash
# `dbt parse` each folder in $DBT_PARSE (one per line), so a check reads a manifest of this commit and not a
# committed copy. governance.yml runs it in a step that holds no token, because dbt runs the PR's Jinja.
#
#   DBT=<dbt with dbt-duckdb> DBT_PARSE="transform\n..." bash dbt-parse.sh
#
# Each folder's target/manifest.json is deleted first, so a parse that fails leaves no manifest behind and
# the check that wanted one records not_run, never a pass on an old copy. The profile is a throwaway duckdb
# one under the project's own profile name; parse opens no connection. Exit 0 every folder parsed; 1 one did
# not (the checks still run, and the step after this one records what they find); 2 bad usage.
set -uo pipefail
DBT="${DBT:-}"
[[ -n "$DBT" && -x "$DBT" ]] || { echo "::error::dbt-parse.sh: DBT=$DBT is not an executable"; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failed=0
while IFS= read -r dir; do
  dir="${dir%$'\r'}"
  [[ -z "${dir//[[:space:]]/}" ]] && continue
  if [[ ! -f "$dir/dbt_project.yml" ]]; then
    echo "::error::dbt_parse: no dbt_project.yml in $(printf '%q' "$dir")"
    failed=1
    continue
  fi
  rm -f "$dir/target/manifest.json"
  profile="$(sed -n -E 's/^profile:[[:space:]]*["'\'']?([A-Za-z_][A-Za-z0-9_]*)["'\'']?[[:space:]]*(#.*)?$/\1/p' "$dir/dbt_project.yml" | head -n1)"
  [[ -n "$profile" ]] || profile="$(sed -n -E 's/^name:[[:space:]]*["'\'']?([A-Za-z_][A-Za-z0-9_]*)["'\'']?[[:space:]]*(#.*)?$/\1/p' "$dir/dbt_project.yml" | head -n1)"
  [[ -n "$profile" ]] || { echo "::error::dbt_parse: no profile or name in $(printf '%q' "$dir")/dbt_project.yml"; failed=1; continue; }
  p="$tmp/profiles-$failed-$RANDOM"
  mkdir -p "$p"
  printf '%s:\n  target: gates\n  outputs:\n    gates:\n      type: duckdb\n      path: "%s"\n' "$profile" "$p/parse.duckdb" > "$p/profiles.yml"
  echo "dbt parse $(printf '%q' "$dir") (profile $profile)"
  if ! (cd "$dir" && "$DBT" deps --profiles-dir "$p" --target gates && "$DBT" parse --profiles-dir "$p" --target gates); then
    echo "::warning::dbt parse failed in $(printf '%q' "$dir"); its manifest is absent, so a check that reads it records not_run"
    rm -f "$dir/target/manifest.json"
    failed=1
  fi
done <<< "${DBT_PARSE:-}"
exit $failed
