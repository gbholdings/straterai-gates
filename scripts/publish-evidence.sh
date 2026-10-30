#!/usr/bin/env bash
# Commit evidence.json to the evidence branch, writing only that file. Run from a checkout of the caller's repo.
# Env: EVIDENCE_FILE (path of the new file), EVIDENCE_BRANCH, REMOTE (default origin), TARGET_PATH (default governance/evidence.json)
set -euo pipefail
REMOTE=${REMOTE:-origin}
TARGET_PATH=${TARGET_PATH:-governance/evidence.json}
: "${EVIDENCE_FILE:?}" "${EVIDENCE_BRANCH:?}"
# GH_TOKEN, when set, authenticates the fetch and push without persisting credentials in the checkout.
AUTH=()
if [ -n "${GH_TOKEN:-}" ]; then
  AUTH=(-c "http.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
fi
W=$(mktemp -d)
trap 'git worktree remove --force "$W" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
if git "${AUTH[@]}" ls-remote --exit-code --heads "$REMOTE" "$EVIDENCE_BRANCH" >/dev/null 2>&1; then
  git "${AUTH[@]}" fetch --quiet "$REMOTE" "$EVIDENCE_BRANCH"
  git worktree add --quiet --detach "$W" FETCH_HEAD
else
  git worktree add --quiet --detach "$W"
  git -C "$W" checkout --quiet --orphan "$EVIDENCE_BRANCH"
  git -C "$W" rm -rfq --ignore-unmatch . >/dev/null
fi
mkdir -p "$W/$(dirname "$TARGET_PATH")"
cp "$EVIDENCE_FILE" "$W/$TARGET_PATH"
git -C "$W" add -- "$TARGET_PATH"
if git -C "$W" diff --cached --quiet; then echo "evidence unchanged"; exit 0; fi
git -C "$W" -c user.name="straterai-gates[bot]" -c user.email="noreply@users.noreply.github.com" commit --quiet -m "evidence: update $TARGET_PATH"
git -C "$W" "${AUTH[@]}" push --quiet "$REMOTE" "HEAD:refs/heads/$EVIDENCE_BRANCH"
echo "evidence pushed to $EVIDENCE_BRANCH"
