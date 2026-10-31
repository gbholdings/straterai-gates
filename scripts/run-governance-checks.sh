#!/usr/bin/env bash
# Runs each line of $CHECKS through governance-check.mjs and records one evidence entry per line. The
# governance.yml "Run checks and record evidence" step calls this; test/run-governance-checks.test.mjs
# drives it directly.
#
#   CHECKS="<plugin>:<skill>/<gate>=<arguments>\n..." [GC=<governance-check.mjs>] [RUN_LINK=..] [COMMIT=..]
#   bash run-governance-checks.sh
#
# The result recorded is the check's own status (governance-check writes pass, fail or not_run to
# GOVERNANCE_STATUS_FILE), not its exit code: a check that printed a NOT CHECKED line records not_run
# whatever it exited with. A status that is missing, unreadable or says pass with a non-zero exit records
# not_run or fail, never pass. Anything but pass fails this script, so the job fails either way. A check's output is
# printed between ::stop-commands:: markers with a random token, so text from the checked repository (a path
# or a model name) can never become a workflow command.
set -uo pipefail
GC="${GC:-.gates/scripts/governance-check.mjs}"
[ -f "$GC" ] || { echo "::error::$GC is missing from the gates checkout"; exit 1; }
failed=0
ran=0
while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -z "${line// /}" ] && continue
  case "$line" in \#*) continue ;; esac
  case "$line" in *=*) ;; *) echo "::error::bad checks line (want name=args): $(printf '%q' "$line")"; failed=1; continue ;; esac
  name="${line%%=*}"
  read -r -a args <<< "${line#*=}"
  ran=1
  token="gates-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  status_file="$(mktemp)"
  echo "::stop-commands::$token"
  GOVERNANCE_STATUS_FILE="$status_file" node "$GC" "${args[@]}" 2>&1
  rc=$?
  echo "::$token::"
  status="$(head -c 16 "$status_file" 2>/dev/null | tr -d '\r\n')"
  rm -f "$status_file"
  case "$status:$rc" in
    pass:0) result=pass ;;
    fail:*) result=fail ;;
    not_run:*) result=not_run ;;
    pass:*) result=fail ;;
    *:0 | *:2) result=not_run ;;
    *) result=fail ;;
  esac
  case "$result" in
    not_run) echo "::error::$(printf '%q' "$name") was NOT CHECKED (exit $rc)" ;;
    fail) echo "::error::$(printf '%q' "$name") failed (exit $rc)" ;;
  esac
  [ "$result" = pass ] || failed=1
  meta=()
  [ -z "${RUN_LINK:-}" ] || meta+=(--run-link "$RUN_LINK")
  [ -z "${COMMIT:-}" ] || meta+=(--commit "$COMMIT")
  node "$GC" evidence append --check "$name" --result "$result" "${meta[@]}" --detail "$result, exit $rc" || exit $?
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "recorded=true" >> "$GITHUB_OUTPUT"
done <<< "${CHECKS:-}"
# A gate that ran nothing is NOT CHECKED, never a pass: an empty or all-comment `checks` fails the job.
if [ "$ran" != 1 ]; then echo "::error::no checks configured: NOT CHECKED, nothing recorded"; exit 1; fi
exit $failed
