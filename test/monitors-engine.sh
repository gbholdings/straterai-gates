#!/usr/bin/env bash
# `governance-check monitors` against what the real tools write: a manifest from `dbt parse` of a dbt-duckdb
# project with the Elementary package, and file data contexts written by GX Core and loaded back in GX. Each
# passing input must exit 0, and each break must exit 1 (or 2, NOT CHECKED) on its own line, so a check that
# stops finding it turns this red. No line of the check's output may start a workflow command.
#
#   DBT=<dbt with dbt-duckdb> GX_PYTHON=<python with great_expectations> bash test/monitors-engine.sh
#
# GC=<another governance-check.mjs> runs the same cases on another copy of the check, to show which of them
# an older one passes.
#
# Exit 0 every case ended as it must; 1 a case did not; 2 bad usage or a missing tool (never a pass).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GC="${GC:-$HERE/../scripts/governance-check.mjs}"
FIX="$HERE/fixtures/governance/monitors"
DBT="${DBT:-}"
GX_PYTHON="${GX_PYTHON:-}"
[[ $# -eq 0 ]] || { echo "monitors-engine.sh: takes no arguments" >&2; exit 2; }
[[ -n "$DBT" && -x "$DBT" ]] || { echo "monitors-engine.sh: DBT=$DBT is not an executable; monitors is NOT CHECKED on a real manifest" >&2; exit 2; }
[[ -n "$GX_PYTHON" && -x "$GX_PYTHON" ]] || { echo "monitors-engine.sh: GX_PYTHON=$GX_PYTHON is not an executable; monitors is NOT CHECKED on a real GX context" >&2; exit 2; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export DO_NOT_TRACK=1 DBT_SEND_ANONYMOUS_USAGE_STATS=false GX_ANALYTICS_ENABLED=false
unset GATES_GX_PYTHON
failed=0
want() {
  local label="$1" code="$2" line="$3" out rc; shift 3
  set +e; out="$(node "$GC" monitors "$@" 2>&1)"; rc=$?; set -e
  # printed escaped, so this script's own log cannot be steered by what it prints
  printf '%s\n' "$out" | sed 's/^\([[:space:]]*\)::/\1: :/'
  if grep -qE '^[[:space:]]*::' <<<"$out"; then
    echo "::error::$label: a line of the check's output starts a workflow command"; failed=1
  elif [[ $rc -ne $code ]] || ! grep -qF -- "$line" <<<"$out"; then
    echo "::error::$label: exited $rc, wanted $code with: $line"; failed=1
  else
    echo "$label: exit $rc, as it must"
  fi
}

# One dbt deps for every case; each case then parses its own copy of the project.
cp -a "$FIX/elementary/project" "$T/deps"
(cd "$T/deps" && DBT_PROFILES_DIR="$T/deps" "$DBT" deps --quiet) || { echo "monitors-engine.sh: dbt deps failed" >&2; exit 2; }
reparse() {
  local d="$1"
  (cd "$d" && MON_DUCKDB_PATH="$d/mon.duckdb" DBT_PROFILES_DIR="$d" "$DBT" parse >"$d/parse.log" 2>&1) || { cat "$d/parse.log" >&2; echo "monitors-engine.sh: dbt parse failed in $d" >&2; exit 2; }
}
parse() {
  local name="$1" d="$T/el-$1"
  cp -a "$FIX/elementary/project" "$d"
  [[ "$name" == pass ]] || cp -a "$FIX/elementary/$name/." "$d/"
  # dbt parse checks dbt_packages against the lock that dbt deps wrote
  cp -a "$T/deps/dbt_packages" "$T/deps/package-lock.yml" "$d/"
  reparse "$d"
  echo "$d"
}
d="$(parse pass)"; want "elementary, routed" 0 "monitors: 4 Elementary monitor(s), each with an alert destination and an owner" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-route)"; want "elementary, no route" 1 "(elementary.volume_anomalies on customers): no alert destination" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-owner)"; want "elementary, no owner" 1 "(elementary.volume_anomalies on orders): no owner" --repo "$d" --manifest "$d/target/manifest.json"
d="$(parse no-monitors)"; want "elementary, no monitors" 2 "monitors is NOT CHECKED" --repo "$d" --manifest "$d/target/manifest.json"

# Review finding 1: a model added after the parse; then the same tree parsed again; then a manifest given
# against another project's tree.
d="$T/el-stale"; cp -a "$T/el-pass" "$d"
printf 'select 1 as payment_id, current_timestamp as updated_at\n' > "$d/models/payments.sql"
printf '  - name: payments\n    data_tests:\n      - elementary.volume_anomalies:\n          arguments:\n            timestamp_column: updated_at\n' >> "$d/models/schema.yml"
want "elementary, a model added after the parse" 2 "models/payments.sql is not in the manifest" --repo "$d" --manifest "$d/target/manifest.json"
reparse "$d"
want "elementary, the same tree parsed again" 1 "(elementary.volume_anomalies on payments): no alert destination" --repo "$d" --manifest "$d/target/manifest.json"
o="$T/el-other"; cp -a "$T/el-no-route" "$o"; sed -i 's/^name: monitors_fixture/name: other_project/' "$o/dbt_project.yml"
want "elementary, a manifest of another project" 2 "and --repo holds no dbt project of that name" --repo "$o" --manifest "$T/el-pass/target/manifest.json"

# Review finding 2: TODO for the owner and tbd for the channel.
d="$(parse placeholders)"
want "elementary, placeholder owner and channel" 1 'alert destination is a placeholder ("tbd")' --repo "$d" --manifest "$d/target/manifest.json"
want "elementary, placeholder owner" 1 "(elementary.schema_changes on orders): owner is a placeholder" --repo "$d" --manifest "$d/target/manifest.json"

# Review finding 3: suppressed for 100000 hours after the first alert.
d="$(parse suppressed)"
want "elementary, suppressed for years" 1 "alert_suppression_interval 100000 hours" --repo "$d" --manifest "$d/target/manifest.json"

# Review finding 4: a second dbt project with Elementary that no manifest covers.
r="$T/two-projects"; mkdir -p "$r"; cp -a "$T/el-pass" "$r/first"; cp -a "$T/el-no-route" "$r/second"
want "elementary, a second project no manifest covers" 2 "dbt project second uses Elementary and no --manifest covers it" --repo "$r" --manifest "$r/first/target/manifest.json"

for v in routed no-route success-only no-owner placeholder-owner email-no-smtp; do
  (cd "$T" && "$GX_PYTHON" -I "$FIX/gx/make_context.py" "$T/gx-$v" "$v") || { echo "monitors-engine.sh: GX could not write the $v context" >&2; exit 2; }
done
G=(--gx-python "$GX_PYTHON")
want "gx, routed" 0 "monitors: 1 GX monitor(s), each with an alert destination and an owner" --repo "$T/gx-routed" --gx "$T/gx-routed/gx" "${G[@]}"
want "gx, no route" 1 "checkpoint orders_arrived: no deliverable alert destination" --repo "$T/gx-no-route" --gx "$T/gx-no-route/gx" "${G[@]}"
want "gx, success only" 1 "checkpoint orders_arrived: no deliverable alert destination" --repo "$T/gx-success-only" --gx "$T/gx-success-only/gx" "${G[@]}"
want "gx, no owner" 1 "suite orders_arrived has no owner" --repo "$T/gx-no-owner" --gx "$T/gx-no-owner/gx" "${G[@]}"
want "gx, never loaded in GX" 2 "was not loaded in GX" --repo "$T/gx-routed" --gx "$T/gx-routed/gx"
# Review finding 2: a TODO suite owner. Finding 3: an email action with no SMTP server, which GX refuses.
want "gx, placeholder owner" 1 "suite orders_arrived owner is a placeholder" --repo "$T/gx-placeholder-owner" --gx "$T/gx-placeholder-owner/gx" "${G[@]}"
want "gx, email with no smtp server" 1 "GX refuses to load it" --repo "$T/gx-email-no-smtp" --gx "$T/gx-email-no-smtp/gx" "${G[@]}"
# Review finding 4: a second GX context that no --gx covers.
r="$T/two-contexts"; cp -a "$T/gx-routed" "$r"; mkdir -p "$r/jobs"; cp -a "$T/gx-no-route/gx" "$r/jobs/gx"
want "gx, a second context no --gx covers" 2 "GX context jobs/gx is not covered by a --gx" --repo "$r" --gx "$r/gx" "${G[@]}"

# Both tools in one repository: the dbt project with Elementary, and a GX context beside it.
d="$T/el-both"; cp -a "$T/el-pass" "$d"; cp -a "$T/gx-routed/gx" "$d/gx"
want "elementary and gx together" 1 "configures both Elementary (packages.yml) and GX (gx/great_expectations.yml)" --repo "$d" --manifest "$d/target/manifest.json"

# Review finding 4: GX pulled in by the Airflow provider, from requirements/prod.txt, or in a Dockerfile.
for spec in "requirements.txt|apache-airflow-providers-great-expectations==1.0.0" "requirements/prod.txt|great_expectations==1.24.1" "Dockerfile|RUN pip install great_expectations==1.24.1"; do
  f="${spec%%|*}"; d="$T/dep-${f//[\/.]/_}"; cp -a "$T/el-pass" "$d"; mkdir -p "$(dirname "$d/$f")"; printf '%s\n' "${spec#*|}" > "$d/$f"
  want "elementary and gx through $f" 1 "and GX ($f)" --repo "$d" --manifest "$d/target/manifest.json"
done

# Review finding 5: a directory whose name holds a newline and a workflow command, beside Elementary.
d="$T/inject"; cp -a "$T/el-pass" "$d"; evil="$d/x"$'\n'"::warning title=injected::owned"; mkdir -p "$evil"; cp "$T/gx-routed/gx/great_expectations.yml" "$evil/"
want "a path that would inject a workflow command" 1 "configures both Elementary (packages.yml) and GX" --repo "$d" --manifest "$d/target/manifest.json"
exit $failed
