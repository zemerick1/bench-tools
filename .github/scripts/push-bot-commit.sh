#!/usr/bin/env bash
# Rebase a bot commit onto the current remote branch and push.
# Scheduled jobs often lose a race with a merge or another bot push.
set -euo pipefail

branch="${1:-${GITHUB_REF_NAME:?GITHUB_REF_NAME is not set}}"
max_attempts=5
attempt=0

until git fetch origin "$branch" \
  && git rebase "origin/$branch" \
  && git push origin "HEAD:$branch"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "push still rejected after ${attempt} attempts"
    exit 1
  fi
  echo "rebase/push failed; retry ${attempt}"
  git rebase --abort 2>/dev/null || true
  sleep $((attempt * 4))
done
