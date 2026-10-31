#!/usr/bin/env bash
# Runs each line of $CHECKS through governance-check.mjs and records one evidence entry per line. The
# governance.yml "Run checks and record evidence" step calls this; test/run-governance-checks.test.mjs
# drives it directly.
#
#   CHECKS="<plugin>:<skill>/<gate>=<arguments>\n..." [GC=<governance-check.mjs>] [RUN_LINK=..] [COMMIT=..]
#   bash run-governance-checks.sh
#
# Exit 0 of a check records pass, exit 2 (NOT CHECKED: the check could not look) records not_run, any other
# exit records fail. Anything but pass fails this script, so the job fails either way. A check's output is
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
  case "$line" in *=*) ;; *) echo "::error::bad checks line (want name=args): $line"; failed=1; continue ;; esac
  name="${line%%=*}"
  read -r -a args <<< "${line#*=}"
  ran=1
  token="gates-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  echo "::stop-commands::$token"
  node "$GC" "${args[@]}" 2>&1
  rc=$?
  echo "::$token::"
  case "$rc" in
    0) result=pass ;;
    2) result=not_run; echo "::error::$name was NOT CHECKED (exit 2)" ;;
    *) result=fail ;;
  esac
  [ "$rc" = 0 ] || failed=1
  meta=()
  [ -z "${RUN_LINK:-}" ] || meta+=(--run-link "$RUN_LINK")
  [ -z "${COMMIT:-}" ] || meta+=(--commit "$COMMIT")
  node "$GC" evidence append --check "$name" --result "$result" "${meta[@]}" --detail "exit $rc" || exit $?
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "recorded=true" >> "$GITHUB_OUTPUT"
done <<< "${CHECKS:-}"
[ "$ran" = 1 ] || echo "::notice::no checks configured; nothing recorded"
exit $failed
