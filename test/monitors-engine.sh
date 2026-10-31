#!/usr/bin/env bash
# `governance-check monitors` against what the real tools write: a manifest from `dbt parse` of a dbt-duckdb
# project with the Elementary package, and file data contexts written by GX Core. Each passing input must
# exit 0, and each break must exit 1 on its own line, so a check that stops finding it turns this red.
#
#   DBT=<dbt with dbt-duckdb> GX_PYTHON=<python with great_expectations> bash test/monitors-engine.sh
#
# Exit 0 every case ended as it must; 1 a case did not; 2 bad usage or a missing tool (never a pass).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC="$HERE/../scripts/governance-check.mjs"
FIX="$HERE/fixtures/governance/monitors"
DBT="${DBT:-}"
GX_PYTHON="${GX_PYTHON:-}"
[[ $# -eq 0 ]] || { echo "monitors-engine.sh: takes no arguments" >&2; exit 2; }
[[ -n "$DBT" && -x "$DBT" ]] || { echo "monitors-engine.sh: DBT=$DBT is not an executable; monitors is NOT CHECKED on a real manifest" >&2; exit 2; }
[[ -n "$GX_PYTHON" && -x "$GX_PYTHON" ]] || { echo "monitors-engine.sh: GX_PYTHON=$GX_PYTHON is not an executable; monitors is NOT CHECKED on a real GX context" >&2; exit 2; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export DO_NOT_TRACK=1 DBT_SEND_ANONYMOUS_USAGE_STATS=false GX_ANALYTICS_ENABLED=false
failed=0
want() {
  local label="$1" code="$2" line="$3" out rc; shift 3
  set +e; out="$(node "$GC" monitors "$@" 2>&1)"; rc=$?; set -e
  printf '%s\n' "$out"
  if [[ $rc -ne $code ]] || ! grep -qF -- "$line" <<<"$out"; then
    echo "::error::$label: exited $rc, wanted $code with: $line"; failed=1
  else
    echo "$label: exit $rc, as it must"
  fi
}

# One dbt deps for every case; each case then parses its own copy of the project.
cp -a "$FIX/elementary/project" "$T/deps"
(cd "$T/deps" && DBT_PROFILES_DIR="$T/deps" "$DBT" deps --quiet) || { echo "monitors-engine.sh: dbt deps failed" >&2; exit 2; }
parse() {
  local name="$1" d="$T/el-$1"
  cp -a "$FIX/elementary/project" "$d"
  [[ "$name" == pass ]] || cp -a "$FIX/elementary/$name/." "$d/"
  # dbt parse checks dbt_packages against the lock that dbt deps wrote
  cp -a "$T/deps/dbt_packages" "$T/deps/package-lock.yml" "$d/"
  (cd "$d" && MON_DUCKDB_PATH="$d/mon.duckdb" DBT_PROFILES_DIR="$d" "$DBT" parse >"$d/parse.log" 2>&1) || { cat "$d/parse.log" >&2; echo "monitors-engine.sh: dbt parse failed for $name" >&2; exit 2; }
  echo "$d"
}
d="$(parse pass)"; want "elementary, routed" 0 "monitors: 4 Elementary monitor(s), each with an alert destination and an owner" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-route)"; want "elementary, no route" 1 "(elementary.volume_anomalies on customers): no alert destination" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-owner)"; want "elementary, no owner" 1 "(elementary.volume_anomalies on orders): no owner" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-monitors)"; want "elementary, no monitors" 2 "monitors is NOT CHECKED" --repo "$d" --manifest "$d/target/manifest.json"

for v in routed no-route success-only no-owner; do
  (cd "$T" && "$GX_PYTHON" -I "$FIX/gx/make_context.py" "$T/gx-$v" "$v") || { echo "monitors-engine.sh: GX could not write the $v context" >&2; exit 2; }
done
want "gx, routed" 0 "monitors: 1 GX monitor(s), each with an alert destination and an owner" --repo "$T/gx-routed" --gx "$T/gx-routed/gx"
want "gx, no route" 1 "checkpoint orders_arrived: no alert destination" --repo "$T/gx-no-route" --gx "$T/gx-no-route/gx"
want "gx, success only" 1 "checkpoint orders_arrived: no alert destination" --repo "$T/gx-success-only" --gx "$T/gx-success-only/gx"
want "gx, no owner" 1 "suite orders_arrived has no owner" --repo "$T/gx-no-owner" --gx "$T/gx-no-owner/gx"

# Both tools in one repository: the dbt project with Elementary, and a GX context beside it.
d="$T/el-pass"; cp -a "$T/gx-routed/gx" "$d/gx"
want "elementary and gx together" 1 "configures both Elementary (packages.yml) and GX (gx/great_expectations.yml)" --repo "$d" --manifest "$d/target/manifest.json"
exit $failed
